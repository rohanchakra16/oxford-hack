"""Paced question handoff with an injectable placeholder provider."""

from collections.abc import Callable
from uuid import NAMESPACE_URL, uuid5

from .lecture_types import LectureConfig, QuestionRequest, ReviewSegment, TranscriptExcerpt


def placeholder_question(segment: ReviewSegment, context: list[TranscriptExcerpt]) -> str:
    span = segment.media_range
    return (
        f"[Placeholder question] In your own words, what was the main idea explained "
        f"between {span.start_media_s:g}s and {span.end_media_s:g}s? "
        "You can replay the segment before answering."
    )


QuestionProvider = Callable[[ReviewSegment, list[TranscriptExcerpt]], str]


class QuestionScheduler:
    def __init__(
        self,
        config: LectureConfig,
        transcript: list[TranscriptExcerpt],
        provider: QuestionProvider = placeholder_question,
    ):
        self.config, self.transcript, self.provider = config, transcript, provider
        self.pending: list[str] = []
        self.requests: dict[str, QuestionRequest] = {}
        self.states: dict[str, str] = {}
        self.answers: dict[str, str] = {}
        self._requested_segments: set[str] = set()
        self._last_prompt_ms = -float("inf")
        self.active_id: str | None = None

    def queue(self, segment_id: str) -> None:
        if (
            self.config.mode == "educational"
            and segment_id not in self._requested_segments
            and segment_id not in self.pending
        ):
            self.pending.append(segment_id)

    def poll(
        self, now: float, segments: dict[str, ReviewSegment], *, allowed: bool
    ) -> QuestionRequest | None:
        if (
            not allowed
            or self.config.mode == "normal"
            or self.active_id is not None
            or not self.pending
            or now - self._last_prompt_ms < self.config.question_cooldown_ms
        ):
            return None
        segment_id = self.pending[0]
        segment = segments[segment_id]
        span = segment.media_range
        context = [
            excerpt
            for excerpt in self.transcript
            if excerpt.start_media_s < span.end_media_s and excerpt.end_media_s > span.start_media_s
        ][:8]
        text = self.provider(segment, context)  # failure leaves the queue intact
        request = QuestionRequest(
            question_id=uuid5(NAMESPACE_URL, f"lecture-question:{segment.session_id}:{segment_id}").hex,
            segment_id=segment_id,
            session_id=segment.session_id,
            video_id=segment.video_id,
            lecture_revision=segment.lecture_revision,
            config_fingerprint=segment.config_fingerprint,
            affected_range=span,
            attention_level=segment.attention_level,
            transcript_context=context,
            requested_backend_ms=now,
            timing=self.config.question_timing,
            source=segment.source,
            question_text=text,
        )
        self.pending.pop(0)
        self._requested_segments.add(segment_id)
        self.requests[request.question_id] = request
        self.states[request.question_id] = "requested"
        self.active_id = request.question_id
        self._last_prompt_ms = now
        return request

    def presented(self, question_id: str, now: float) -> None:
        if self.states[question_id] == "requested":
            self.states[question_id] = "presented"
            # Delayed UI delivery restarts the cooldown at actual presentation.
            self._last_prompt_ms = max(self._last_prompt_ms, now)

    def resolve(self, question_id: str, action: str, now: float, answer: str | None) -> None:
        self.presented(question_id, now)
        self.states[question_id] = "answered" if action == "answer" else "dismissed"
        if answer is not None:
            self.answers[question_id] = answer
        self.active_id = None
