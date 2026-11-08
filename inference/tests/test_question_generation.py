import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from inference.question_generation import (
    OPENROUTER_URL,
    OpenRouterQuestionGenerator,
    QuestionGenerationError,
    quote_in_excerpt,
    register_question_routes,
    scheduler_provider,
)

EXCERPT = (
    "Ohm's law links voltage, current and resistance. At a fixed voltage, current decreases as "
    "resistance increases, because I equals V divided by R."
)
ORIGIN = "http://127.0.0.1:5173"


def reply(content, status=200, headers=None):
    body = {"model": "some/free-model", "choices": [{"message": {"content": content}}]}
    return status, headers or {}, json.dumps(body).encode()


def good_content(quote="At a fixed voltage, current decreases as resistance increases"):
    return json.dumps(
        {
            "status": "ready",
            "question": "What happens to current when resistance rises at a fixed voltage?",
            "suggested_answer": "It decreases, because I = V/R.",
            "supporting_quote": quote,
        }
    )


class FakeTransport:
    def __init__(self, *responses):
        self.responses, self.calls = list(responses), []

    def __call__(self, url, headers, body, timeout):
        self.calls.append((url, dict(headers), json.loads(body)))
        return self.responses.pop(0)


def gen(transport, **kw):
    return OpenRouterQuestionGenerator(api_key="sk-test", transport=transport, clock=lambda: 1000.0, **kw)


def test_ready_question_and_request_shape():
    t = FakeTransport(reply(good_content()))
    result = gen(t).generate(EXCERPT)
    assert result.status == "ready" and result.quote_verified and not result.cached
    assert result.model == "some/free-model"
    url, headers, body = t.calls[0]
    assert url == OPENROUTER_URL and headers["Authorization"] == "Bearer sk-test"
    assert body["model"] == "openrouter/free"
    assert body["response_format"]["type"] == "json_schema"
    assert body["provider"] == {"require_parameters": True}
    sent = json.dumps(body)
    assert EXCERPT in sent and "sk-test" not in sent  # only the excerpt is sent; key only in header


def test_cache_avoids_second_request():
    t = FakeTransport(reply(good_content()))
    g = gen(t)
    g.generate(EXCERPT)
    again = g.generate("  " + EXCERPT.replace(" ", "  ") + " ")
    assert again.cached and len(t.calls) == 1


def test_paraphrased_quote_is_flagged_not_rejected():
    t = FakeTransport(reply(good_content(quote="Current falls when resistance goes up")))
    assert gen(t).generate(EXCERPT).quote_verified is False


def test_fenced_json_is_accepted():
    t = FakeTransport(reply("Here you go:\n```json\n" + good_content() + "\n```"))
    assert gen(t).generate(EXCERPT).status == "ready"


def test_short_excerpt_skips_request():
    t = FakeTransport()
    assert gen(t).generate("Okay, so, um.").status == "insufficient_context"
    assert t.calls == []


def test_model_insufficient_context():
    t = FakeTransport(
        reply(
            json.dumps(
                {
                    "status": "insufficient_context",
                    "question": "",
                    "suggested_answer": "",
                    "supporting_quote": "",
                }
            )
        )
    )
    assert gen(t).generate(EXCERPT).status == "insufficient_context"


def test_missing_key():
    g = OpenRouterQuestionGenerator(api_key="", transport=FakeTransport())
    with pytest.raises(QuestionGenerationError) as error:
        g.generate(EXCERPT)
    assert error.value.code == "not_configured"


def test_rate_limit_blocks_until_retry_after():
    now = [1000.0]
    t = FakeTransport((429, {"Retry-After": "30"}, b'{"error":{"code":429}}'))
    g = OpenRouterQuestionGenerator(api_key="k", transport=t, clock=lambda: now[0])
    with pytest.raises(QuestionGenerationError) as first:
        g.generate(EXCERPT)
    assert first.value.code == "rate_limited" and first.value.retry_after_s == 30
    with pytest.raises(QuestionGenerationError) as second:
        g.generate(EXCERPT + " More.")
    assert second.value.code == "rate_limited" and len(t.calls) == 1  # no wasted attempt
    now[0] += 31
    t.responses.append(reply(good_content()))
    assert g.generate(EXCERPT).status == "ready"


@pytest.mark.parametrize("content", ["not json", json.dumps({"status": "ready", "question": "Q?"})])
def test_invalid_output(content):
    with pytest.raises(QuestionGenerationError) as error:
        gen(FakeTransport(reply(content))).generate(EXCERPT)
    assert error.value.code == "invalid_output"


def test_quote_matching_ignores_case_and_punctuation():
    assert quote_in_excerpt("at a FIXED voltage current decreases", EXCERPT)
    assert not quote_in_excerpt("voltage", EXCERPT)  # too short to count as evidence


def test_scheduler_provider_falls_back_to_placeholder():
    from inference.lecture_types import TranscriptExcerpt

    g = OpenRouterQuestionGenerator(api_key="", transport=FakeTransport())
    provide = scheduler_provider(g, fallback=lambda segment, context: "placeholder")
    context = [TranscriptExcerpt(start_media_s=0, end_media_s=5, text=EXCERPT)]
    assert provide(None, context) == "placeholder"
    ok = scheduler_provider(gen(FakeTransport(reply(good_content()))))
    assert ok(None, context).startswith("What happens")


def client_with(generator):
    app = FastAPI()
    register_question_routes(app, launch_token="launch", allowed_origins=[ORIGIN], generator=generator)
    return TestClient(app)


BODY = {"bookmarkId": "b1", "videoId": "v1", "startMediaS": 10, "endMediaS": 40, "text": EXCERPT}


def test_route_requires_origin_and_token():
    c = client_with(gen(FakeTransport()))
    assert c.post("/api/v0/questions", json=BODY, headers={"x-launch-token": "launch"}).status_code == 403
    r = c.post("/api/v0/questions", json=BODY, headers={"origin": ORIGIN, "x-launch-token": "no"})
    assert r.status_code == 401


def test_route_success_and_errors():
    t = FakeTransport(reply(good_content()), (429, {"Retry-After": "12"}, b"{}"))
    c = client_with(gen(t))
    h = {"origin": ORIGIN, "x-launch-token": "launch"}
    r = c.post("/api/v0/questions", json=BODY, headers=h)
    assert r.status_code == 200 and r.json()["bookmarkId"] == "b1" and r.json()["suggestedAnswer"]
    r = c.post("/api/v0/questions", json={**BODY, "text": EXCERPT + " Next point."}, headers=h)
    assert r.status_code == 429 and r.headers["retry-after"] == "12" and r.json()["error"] == "rate_limited"
    status = c.get("/api/v0/questions/status", headers=h).json()
    assert status == {"configured": True, "model": "openrouter/free", "promptVersion": "recall-q-v1"}
