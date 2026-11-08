import json

from fastapi import FastAPI
from fastapi.testclient import TestClient

from inference.chatgpt_connection import ChatGPTConnection
from inference.question_generation import OpenRouterQuestionGenerator
from inference.question_routes import register_routes

ORIGIN = "http://127.0.0.1:5173"
HEADERS = {"origin": ORIGIN, "x-launch-token": "launch"}
TEXT = (
    "At a fixed voltage, increasing resistance decreases current because current "
    "equals voltage divided by resistance."
)


class Provider:
    def __init__(self):
        self.calls = []
        self.skip = False

    def __call__(self, url, headers, raw, timeout):
        body = json.loads(raw)
        self.calls.append(body)
        schema = body["response_format"]["json_schema"]["schema"]
        if schema.get("title") == "ChunkOutline":
            result = {
                "summary": "A lecture about electric circuits.",
                "blocks": [
                    {
                        "start_sentence": 0,
                        "end_sentence": 0,
                        "topic": "Resistance",
                        "summary": "Current falls as resistance increases.",
                        "kind": "teaching",
                    },
                    {
                        "start_sentence": 1,
                        "end_sentence": 1,
                        "topic": "Break",
                        "summary": "A short break.",
                        "kind": "break",
                    },
                ],
            }
        elif schema.get("title") == "GlobalSummary":
            result = {
                "summary": "Electric circuits: voltage, current and resistance, with a short break."
            }
        elif self.skip:
            result = {
                "status": "skipped_non_instructional",
                "question": "",
                "suggested_answer": "",
                "supporting_quote": "",
                "skip_reason": "This passage is a break with no teaching point.",
            }
        else:
            result = {
                "status": "ready",
                "question": "How does resistance affect current?",
                "suggested_answer": "Increasing resistance reduces current at a fixed voltage.",
                "supporting_quote": "increasing resistance decreases current",
                "skip_reason": "",
            }
        return (
            200,
            {},
            json.dumps(
                {
                    "model": "test-model",
                    "choices": [
                        {
                            "finish_reason": "stop",
                            "message": {"content": json.dumps(result)},
                        }
                    ],
                }
            ).encode(),
        )


def setup(tmp_path):
    provider = Provider()
    app = FastAPI()
    gen = OpenRouterQuestionGenerator(api_key="synthetic", transport=provider)
    register_routes(
        app,
        launch_token="launch",
        allowed_origins=[ORIGIN],
        generator=gen,
        connection=ChatGPTConnection(tmp_path / "registrations.json"),
    )
    return TestClient(app), provider


BODY = {
    "videoId": "v1",
    "sentences": [
        {"startMediaS": 0, "endMediaS": 10, "text": TEXT},
        {
            "startMediaS": 10,
            "endMediaS": 20,
            "text": "Take a short break now and return in five minutes with some water.",
        },
    ],
}


def test_context_preparation_is_authenticated_cached_and_original_only(tmp_path):
    client, provider = setup(tmp_path)
    assert client.post("/api/v0/questions/context", json=BODY).status_code == 403
    context = client.post(
        "/api/v0/questions/context", json=BODY, headers=HEADERS
    ).json()
    again = client.post("/api/v0/questions/context", json=BODY, headers=HEADERS).json()
    assert again == context and len(provider.calls) == 2
    request = {
        "bookmarkId": "b1",
        "videoId": "v1",
        "text": TEXT,
        "startMediaS": 0,
        "endMediaS": 10,
        "contextId": context["contextId"],
        "targetStartMediaS": 0,
        "targetEndMediaS": 10,
    }
    result = client.post("/api/v0/questions", json=request, headers=HEADERS)
    assert result.status_code == 200 and result.json()["status"] == "ready"
    prompt = provider.calls[-1]["messages"][1]["content"]
    assert (
        "lecture_summary" in prompt
        and "target_passage" in prompt
        and "neighbouring_blocks" in prompt
    )
    assert (
        "Take a short break now" in prompt
    )  # original neighbour evidence, not only its generated summary
    assert len(provider.calls) == 3
    assert (
        client.post("/api/v0/questions/context", json=BODY, headers=HEADERS).json()
        == context
    )
    assert len(provider.calls) == 3
    wrong_video = client.post(
        "/api/v0/questions", json={**request, "videoId": "v2"}, headers=HEADERS
    )
    assert wrong_video.status_code == 409 and len(provider.calls) == 3


def test_noninstructional_outcome_preserves_bookmark_identity(tmp_path):
    client, provider = setup(tmp_path)
    context = client.post(
        "/api/v0/questions/context", json=BODY, headers=HEADERS
    ).json()
    provider.skip = True
    response = client.post(
        "/api/v0/questions",
        headers=HEADERS,
        json={
            "bookmarkId": "break-flag",
            "videoId": "v1",
            "text": BODY["sentences"][1]["text"],
            "startMediaS": 10,
            "endMediaS": 20,
            "contextId": context["contextId"],
        },
    )
    assert response.json()["status"] == "skipped_non_instructional"
    assert response.json()["bookmarkId"] == "break-flag"
    assert response.json()["question"] == ""
    assert response.json()["skipReason"]


def test_chatgpt_selection_never_falls_back_to_openrouter(tmp_path):
    client, provider = setup(tmp_path)
    response = client.post(
        "/api/v0/questions/context",
        headers=HEADERS,
        json={
            **BODY,
            "selection": {
                "provider": "chatgpt",
                "accountId": "not-connected",
                "model": "a-model",
            },
        },
    )
    assert response.status_code == 401 and response.json()["error"] == "not_connected"
    assert not provider.calls
    assert client.post("/api/v0/questions/chatgpt/connect", json={}).status_code == 403
    assert (
        client.post("/api/v0/questions/chatgpt/disconnect", json={}).status_code == 403
    )
