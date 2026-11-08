"""Offline handoff tests for generated OUTPUT limits (not transcript input limits).

Copy into inference/tests once the implementation owner accepts the handoff.
Only synthetic text and injected responses are used; no provider is contacted.
Run with the intended checkout first on PYTHONPATH and disable bytecode/cache writes.
"""

import json

import pytest

from inference.question_generation import (
    OpenRouterQuestionGenerator,
    QuestionGenerationError,
)

QUOTE = ("At a fixed voltage, increasing resistance decreases current. " * 13).strip()
EXCERPT = (
    QUOTE
    + " Ohm's law relates current, voltage and resistance through I equals V divided by R."
)
SHORT = {
    "status": "ready",
    "question": "Why does current decrease when resistance increases at fixed voltage?",
    "suggested_answer": "Ohm's law gives I = V/R, so increasing R decreases I at fixed V.",
    "supporting_quote": "At a fixed voltage, increasing resistance decreases current.",
}


def reply(fields, finish_reason="stop"):
    return (
        200,
        {},
        json.dumps(
            {
                "model": "offline-test-model",
                "choices": [
                    {
                        "finish_reason": finish_reason,
                        "message": {"content": json.dumps(fields)},
                    }
                ],
            }
        ).encode(),
    )


class FakeTransport:
    """Reject unbounded retries explicitly instead of eventually exhausting a list."""

    def __init__(self, *responses, repeat_last=False):
        self.responses = list(responses)
        self.calls = []
        self.repeat_last = repeat_last

    def __call__(self, url, headers, body, timeout):
        self.calls.append(json.loads(body))
        assert len(self.calls) <= 8, "Generation retried more than eight times."
        assert self.responses, "Unexpected extra provider request."
        return (
            self.responses[0]
            if self.repeat_last and len(self.responses) == 1
            else self.responses.pop(0)
        )


def generator(transport):
    return OpenRouterQuestionGenerator(
        api_key="offline-placeholder", transport=transport, clock=lambda: 1000.0
    )


def fields(result):
    return result.question, result.suggested_answer, result.supporting_quote


def assert_short_complete(result):
    assert result.status == "ready"
    assert fields(result) == tuple(
        SHORT[key] for key in ("question", "suggested_answer", "supporting_quote")
    )


def test_complete_output_above_soft_limit_survives_without_legacy_field_slices():
    content = {
        "status": "ready",
        "question": (
            "Why does increasing resistance reduce current at fixed voltage? " * 10
        ).strip(),
        "suggested_answer": (
            "Ohm's law states that current equals voltage divided by resistance. " * 27
        ).strip(),
        "supporting_quote": QUOTE,
    }
    total = sum(
        len(content[key])
        for key in ("question", "suggested_answer", "supporting_quote")
    )
    assert 3000 < total <= 3500, "The fixture must exercise the soft-to-hard allowance."
    transport = FakeTransport(reply(content))
    result = generator(transport).generate(EXCERPT)
    assert result.status == "ready"
    assert fields(result) == tuple(
        content[key] for key in ("question", "suggested_answer", "supporting_quote")
    )
    assert len(transport.calls) == 1


def test_output_above_hard_limit_is_rejected_or_regenerated_not_silently_sliced():
    overlong = {
        **SHORT,
        "suggested_answer": "Current equals voltage divided by resistance. " * 100,
    }
    transport = FakeTransport(reply(overlong), reply(SHORT))
    try:
        result = generator(transport).generate(EXCERPT)
    except QuestionGenerationError:
        pass  # Safe rejection is allowed; retry policy belongs to the implementation.
    else:
        assert_short_complete(result)
        assert len(transport.calls) == 2, (
            "An oversized response must not be accepted after slicing."
        )


@pytest.mark.parametrize("finish_reason", ["length"])
def test_parseable_json_reported_incomplete_is_rejected_or_regenerated(finish_reason):
    unfinished = {**SHORT, "question": "Why does the current decrease when"}
    transport = FakeTransport(reply(unfinished, finish_reason), reply(SHORT))
    try:
        result = generator(transport).generate(EXCERPT)
    except QuestionGenerationError:
        return
    assert_short_complete(result)
    assert len(transport.calls) == 2


def test_repeated_incomplete_responses_have_bounded_retry_and_are_not_cached():
    transport = FakeTransport(reply(SHORT, "length"), repeat_last=True)
    service = generator(transport)
    with pytest.raises(QuestionGenerationError):
        service.generate(EXCERPT)
    assert 1 <= len(transport.calls) <= 4, "Use a small bounded retry budget."
    attempts = len(transport.calls)
    transport.responses = [reply(SHORT)]
    result = service.generate(EXCERPT)
    assert_short_complete(result)
    assert not result.cached
    assert len(transport.calls) == attempts + 1
    cached = service.generate(EXCERPT)
    assert cached.cached
    assert len(transport.calls) == attempts + 1


def test_malformed_incomplete_output_is_not_cached_and_can_be_retried():
    raw = json.dumps(
        {
            "choices": [
                {
                    "finish_reason": "length",
                    "message": {"content": '{"status":"ready",'},
                }
            ]
        }
    ).encode()
    transport = FakeTransport((200, {}, raw), repeat_last=True)
    service = generator(transport)
    with pytest.raises(QuestionGenerationError):
        service.generate(EXCERPT)
    assert 1 <= len(transport.calls) <= 4
    attempts = len(transport.calls)
    transport.responses = [reply(SHORT)]
    result = service.generate(EXCERPT)
    assert_short_complete(result)
    assert not result.cached and len(transport.calls) == attempts + 1


def test_generation_prompt_contains_soft_and_hard_output_limits():
    transport = FakeTransport(reply(SHORT))
    generator(transport).generate(EXCERPT)
    prompt = " ".join(message["content"] for message in transport.calls[0]["messages"])
    normalized = prompt.replace(",", "").lower()
    assert "3000" in normalized and "3500" in normalized
    assert "character" in normalized
    assert "sentence" in normalized or "complete" in normalized
