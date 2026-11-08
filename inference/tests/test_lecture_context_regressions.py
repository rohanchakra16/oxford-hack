"""Offline handoff tests for inference.lecture_context; no provider requests.

Run against the question-context checkout by placing that checkout first on
PYTHONPATH. This file can be moved to inference/tests after the author handoff.
"""

import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from pydantic import ValidationError

from inference.lecture_context import (
    ContextError,
    LectureContextInput,
    LectureContextStore,
    TranscriptSentence,
)


class FakeJsonGenerator:
    """Deterministic outline/summary provider recording only synthetic inputs."""

    def __init__(self, ranges=None):
        self.model = "offline-model-v1"
        self.ranges = ranges
        self.calls = []
        self.invalid_summary = False

    def complete_json(self, system, user, schema, max_tokens):
        self.calls.append({"schema": schema["title"], "user": user})
        if schema["title"] == "GlobalSummary":
            return {
                "summary": "" if self.invalid_summary else "Synthetic circuit lecture."
            }
        assert schema["title"] == "ChunkOutline"
        source = json.loads(user)
        ranges = self.ranges
        if ranges is None:
            ranges = [(sentence["index"], sentence["index"]) for sentence in source]
        return {
            "summary": "Original circuit concepts in order.",
            "blocks": [
                {
                    "start_sentence": start,
                    "end_sentence": end,
                    "topic": f"Concept {start}",
                    "summary": f"Explanation for concept {start}.",
                    "kind": "teaching",
                }
                for start, end in ranges
            ],
        }


@pytest.fixture
def transcript():
    return LectureContextInput(
        video_id="synthetic-lecture",
        sentences=[
            TranscriptSentence(
                start_media_s=0, end_media_s=10, text="Voltage drives charge."
            ),
            TranscriptSentence(
                start_media_s=10, end_media_s=20, text="Resistance opposes current."
            ),
            TranscriptSentence(
                start_media_s=20, end_media_s=30, text="Power is voltage times current."
            ),
        ],
    )


def test_multiple_bookmarks_reuse_one_prepared_global_summary(transcript):
    generator = FakeJsonGenerator()
    store = LectureContextStore(generator)
    context = store.prepare(transcript)

    assert context.for_target(1, 4)["target_passage"] == "Voltage drives charge."
    assert (
        context.for_target(21, 24)["target_passage"]
        == "Power is voltage times current."
    )
    assert store.prepare(transcript) is context
    assert [call["schema"] for call in generator.calls] == [
        "ChunkOutline",
        "GlobalSummary",
    ]


@pytest.mark.parametrize("change", ["text", "timestamps", "model"])
def test_cache_invalidates_when_source_or_model_changes(transcript, change):
    generator = FakeJsonGenerator()
    store = LectureContextStore(generator)
    original = store.prepare(transcript)
    updated = transcript.model_copy(deep=True)
    if change == "text":
        updated.sentences[0].text = "Potential difference drives charge."
    elif change == "timestamps":
        updated.sentences[0].end_media_s = 9
    else:
        generator.model = "offline-model-v2"

    replacement = store.prepare(updated)

    assert replacement.context_id != original.context_id
    assert len(generator.calls) == 4
    assert store.prepare(updated) is replacement
    assert len(generator.calls) == 4
    assert original.sentences[0].text == "Voltage drives charge."
    assert original.sentences[0].end_media_s == 10


def test_failed_preparation_is_not_cached(transcript):
    generator = FakeJsonGenerator()
    generator.invalid_summary = True
    store = LectureContextStore(generator)
    with pytest.raises(ContextError):
        store.prepare(transcript)

    generator.invalid_summary = False
    context = store.prepare(transcript)

    assert len(generator.calls) == 4
    assert store.prepare(transcript) is context
    assert len(generator.calls) == 4


def test_context_lookup_is_scoped_to_video(transcript):
    store = LectureContextStore(FakeJsonGenerator())
    context = store.prepare(transcript)

    assert store.get(context.context_id, transcript.video_id) is context
    assert store.get(context.context_id, "different-video") is None
    assert store.get("unknown-context", transcript.video_id) is None


def test_simultaneous_bookmarks_deduplicate_outline_and_summary(transcript):
    generator = FakeJsonGenerator()
    store = LectureContextStore(generator)
    barrier = Barrier(4)

    def prepare_together():
        barrier.wait(timeout=5)
        return store.prepare(transcript)

    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(prepare_together) for _ in range(4)]
        contexts = [future.result(timeout=10) for future in futures]

    assert all(context is contexts[0] for context in contexts)
    assert [call["schema"] for call in generator.calls] == [
        "ChunkOutline",
        "GlobalSummary",
    ]


@pytest.mark.parametrize(
    "ranges",
    [
        [(0, 0), (2, 2)],  # Gap in the middle.
        [(0, 1), (1, 2)],  # Overlapping coverage.
        [(0, 1)],  # Missing the final sentence.
        [(1, 2)],  # Missing the initial sentence.
        [(0, 3)],  # Index outside the original transcript.
    ],
)
def test_invalid_outline_coverage_is_rejected_without_poisoning_cache(
    transcript, ranges
):
    generator = FakeJsonGenerator(ranges)
    store = LectureContextStore(generator)

    with pytest.raises(ContextError):
        store.prepare(transcript)
    assert [call["schema"] for call in generator.calls] == ["ChunkOutline"]

    generator.ranges = None
    assert store.prepare(transcript).summary == "Synthetic circuit lecture."
    assert len(generator.calls) == 3


def test_target_spanning_blocks_preserves_original_sentences_and_global_context(
    transcript,
):
    context = LectureContextStore(FakeJsonGenerator()).prepare(transcript)

    target = context.for_target(9, 21)

    assert target["target_passage"] == " ".join(
        sentence.text for sentence in transcript.sentences
    )
    assert [block["topic"] for block in target["target_blocks"]] == [
        "Concept 0",
        "Concept 1",
        "Concept 2",
    ]
    assert target["lecture_summary"] == context.summary


def test_target_boundaries_do_not_include_previous_or_next_teaching_block(transcript):
    context = LectureContextStore(FakeJsonGenerator()).prepare(transcript)

    target = context.for_target(10, 20)

    assert target["target_passage"] == "Resistance opposes current."
    assert [block["topic"] for block in target["target_blocks"]] == ["Concept 1"]
    assert [block["topic"] for block in target["neighbouring_blocks"]] == [
        "Concept 0",
        "Concept 2",
    ]


def test_point_bookmark_uses_sentence_containing_timestamp(transcript):
    context = LectureContextStore(FakeJsonGenerator()).prepare(transcript)

    target = context.for_target(10, 10)

    assert target["target_passage"] == "Resistance opposes current."
    assert [block["topic"] for block in target["target_blocks"]] == ["Concept 1"]


def test_interval_without_speech_does_not_borrow_unrelated_material(transcript):
    transcript.sentences[2].start_media_s = 25
    context = LectureContextStore(FakeJsonGenerator()).prepare(transcript)

    for start, end in [(21, 24), (100, 110)]:
        target = context.for_target(start, end)
        assert target["target_passage"] == ""
        assert target["target_blocks"] == []
        assert target["neighbouring_blocks"] == []
        assert target["lecture_summary"] == context.summary


@pytest.mark.parametrize(
    "sentence",
    [
        {"start_media_s": -1, "end_media_s": 2, "text": "Invalid start."},
        {"start_media_s": 2, "end_media_s": 1, "text": "Reversed times."},
        {"start_media_s": 0, "end_media_s": float("nan"), "text": "Unknown end."},
        {"start_media_s": 0, "end_media_s": 1, "text": "   "},
    ],
)
def test_invalid_sentence_data_is_rejected(sentence):
    with pytest.raises(ValidationError):
        TranscriptSentence(**sentence)


def test_missing_and_unsorted_transcripts_are_rejected(transcript):
    with pytest.raises(ValidationError):
        LectureContextInput(video_id="empty", sentences=[])
    with pytest.raises(ValidationError):
        LectureContextInput(
            video_id="unsorted", sentences=list(reversed(transcript.sentences))
        )


def test_topic_range_covers_longest_end_when_source_timestamps_overlap():
    """Regression: a later short cue must not erase the block's earlier coverage."""
    transcript = LectureContextInput(
        video_id="overlapping-source-times",
        sentences=[
            TranscriptSentence(
                start_media_s=0, end_media_s=30, text="A long explanation of voltage."
            ),
            TranscriptSentence(
                start_media_s=10, end_media_s=15, text="A brief clarification."
            ),
        ],
    )
    context = LectureContextStore(FakeJsonGenerator(ranges=[(0, 1)])).prepare(
        transcript
    )

    assert context.blocks[0].end_media_s == 30
    target = context.for_target(25, 26)
    assert target["target_passage"] == "A long explanation of voltage."
    assert [block["topic"] for block in target["target_blocks"]] == ["Concept 0"]
