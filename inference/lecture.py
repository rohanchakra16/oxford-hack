"""Deterministic, session-local lecture prototype AFTER evidence-to-media mapping.

Only synthetic / explicitly hypothetical EEGMAT input is accepted. This is not
the live InferenceAdapter and performs no device/browser/backend clock mapping.
"""

import hashlib
import json
import math
from uuid import NAMESPACE_URL, uuid5

from .lecture_questions import QuestionProvider, QuestionScheduler, placeholder_question
from .lecture_types import (
    DemoEvidence,
    LectureConfig,
    MediaRange,
    PlaybackTick,
    QuestionAction,
    ReviewSegment,
    TranscriptExcerpt,
)


class LecturePrototype:
    def __init__(
        self,
        session_id: str,
        video_id: str,
        duration_s: float,
        *,
        lecture_revision: str = "demo-v1",
        config: LectureConfig | None = None,
        transcript: list[TranscriptExcerpt] | None = None,
        question_provider: QuestionProvider = placeholder_question,
    ):
        if not math.isfinite(duration_s) or duration_s <= 0:
            raise ValueError("lecture duration must be positive and finite")
        self.session_id, self.video_id, self.duration_s = session_id, video_id, duration_s
        self.lecture_revision = lecture_revision
        self.config = config or LectureConfig()
        self.config_fingerprint = hashlib.sha256(
            json.dumps(self.config.model_dump(by_alias=False), sort_keys=True, separators=(",", ":")).encode(
                "utf-8"
            )
        ).hexdigest()
        self.questions = QuestionScheduler(self.config, transcript or [], question_provider)
        self.segments: dict[str, ReviewSegment] = {}
        self.status = {
            "level": "unknown",
            "state": "unknown",
            "reason": "waiting for evidence",
            "score": None,
        }
        self.ended = False
        self.now = 0.0
        self._seq = -1
        self._epoch = None
        self._continuity = 0
        self._fresh_since = 0.0
        self._last_end: float | None = None
        self._last_source = None
        self._smoothed: float | None = None
        self._pending: DemoEvidence | None = None
        self._worst = "low attention"
        self._active_segment: str | None = None
        self._recovery_since: float | None = None
        self._seen_evidence: set[str] = set()
        self._seen_ranges: list[tuple[float, float]] = []
        self._actions: dict[str, QuestionAction] = {}
        self._replay_actions: dict[str, str] = {}
        self._last_playback_ms = 0.0
        self._playing = False
        self._replaying = False
        self.qualifications = 0

    def _event(self, kind: str, payload: dict) -> dict:
        return {
            "schemaVersion": "lecture-prototype-0.1.0",
            "type": kind,
            "sessionId": self.session_id,
            "videoId": self.video_id,
            "payload": payload,
        }

    def _clock(self, now: float) -> None:
        if not math.isfinite(now) or now < self.now:
            raise ValueError("monotonic backend clock must not move backwards")
        self.now = now

    def _close_segment(self) -> list[dict]:
        if self._active_segment is None:
            return []
        segment = self.segments[self._active_segment]
        segment = segment.model_copy(update={"closed": True, "revision": segment.revision + 1})
        self.segments[segment.segment_id] = segment
        self._active_segment = None
        return [self._event("review_segment", segment.model_dump(mode="json", by_alias=True))]

    def _break(self, reason: str, *, interrupted=False, boundary: float | None = None) -> list[dict]:
        events = self._close_segment()
        self._continuity += 1
        self._pending = None
        self._smoothed = self._last_end = self._last_source = self._recovery_since = None
        if boundary is not None:
            self._fresh_since = max(self._fresh_since, boundary)
        self.status = {
            "level": "unknown",
            "state": "interrupted" if interrupted else "unknown",
            "reason": reason,
            "score": None,
        }
        events.append(self._event("attention_estimate", dict(self.status, backendMs=self.now)))
        return events

    def _remember(self, span: MediaRange) -> bool:
        """Return false for a fully observed interval, including manual seek-back.

        Track actual visited intervals rather than a high-water mark, so a later
        first visit to a previously skipped part of the lecture is still scored.
        """
        start, end = span.start_media_s, span.end_media_s
        if any(a <= start and end <= b for a, b in self._seen_ranges):
            return False
        merged = []
        for a, b in sorted([*self._seen_ranges, (start, end)]):
            if merged and a <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(b, merged[-1][1]))
            else:
                merged.append((a, b))
        self._seen_ranges = merged
        return True

    def _level(self, score: float) -> str:
        c = self.config
        if score <= c.no_attention_max:
            return "no attention"
        if score <= c.low_attention_max:
            return "low attention"
        return "medium attention" if score <= c.medium_attention_max else "high attention"

    def _record_loss(self, evidence: DemoEvidence, level: str) -> list[dict]:
        events = []
        if self._active_segment is None:
            first = self._pending
            assert first is not None
            self.qualifications += 1
            previous = list(self.segments.values())[-1] if self.segments else None
            gap_s = evidence.media_range.start_media_s
            if previous:
                gap_s = first.media_range.start_media_s - previous.media_range.end_media_s
            if (
                previous
                and previous.continuity_id == self._continuity
                and previous.source == evidence.source
                and gap_s <= self.config.merge_gap_s
                and first.start_backend_ms - previous.last_evidence_backend_ms
                <= self.config.merge_gap_s * 1000
            ):
                segment = previous.model_copy(
                    update={"closed": False, "episode_count": previous.episode_count + 1}
                )
            else:
                segment = ReviewSegment(
                    segment_id=uuid5(
                        NAMESPACE_URL,
                        f"loss:{self.session_id}:{self.video_id}:{self._continuity}:{first.evidence_id}",
                    ).hex,
                    session_id=self.session_id,
                    video_id=self.video_id,
                    lecture_revision=self.lecture_revision,
                    config_fingerprint=self.config_fingerprint,
                    media_range=first.media_range,
                    attention_level=self._worst,
                    source=evidence.source,
                    first_detected_backend_ms=self.now,
                    last_evidence_backend_ms=evidence.end_backend_ms,
                    continuity_id=self._continuity,
                )
            self._active_segment = segment.segment_id
            self.segments[segment.segment_id] = segment
            if self.config.question_timing == "immediate":
                self.questions.queue(segment.segment_id)
        segment = self.segments[self._active_segment]
        worst = (
            "no attention"
            if "no attention" in (segment.attention_level, level, self._worst)
            else "low attention"
        )
        segment = segment.model_copy(
            update={
                "media_range": MediaRange(
                    start_media_s=segment.media_range.start_media_s,
                    end_media_s=max(segment.media_range.end_media_s, evidence.media_range.end_media_s),
                ),
                "attention_level": worst,
                "last_evidence_backend_ms": evidence.end_backend_ms,
                "revision": segment.revision + 1,
            }
        )
        self.segments[segment.segment_id] = segment
        events.append(self._event("review_segment", segment.model_dump(mode="json", by_alias=True)))
        return events

    def advance(self, tick: PlaybackTick) -> list[dict]:
        if tick.session_id != self.session_id or tick.video_id != self.video_id:
            raise ValueError("tick belongs to another lecture/session")
        if tick.duration_s != self.duration_s:
            raise ValueError("lecture duration changed; start a new prototype session")
        if tick.seq <= self._seq or tick.backend_ms < self.now:
            return []
        self._seq = tick.seq
        self._clock(tick.backend_ms)
        self._last_playback_ms = self.now
        self._playing, self._replaying = tick.state == "playing", tick.replaying
        if self.ended:
            return self.poll(self.now)
        if tick.replaying:
            return self._break("review replay", interrupted=True, boundary=self.now)
        if tick.state == "ended":
            events = self._break("lecture ended", interrupted=True, boundary=self.now)
            self.ended = True
            if self.config.question_timing == "end_of_lecture":
                for segment in sorted(self.segments.values(), key=lambda s: s.media_range.start_media_s):
                    self.questions.queue(segment.segment_id)
            return events + self.poll(self.now)
        if not self._playing or tick.replaying:
            return self._break(
                "review replay" if tick.replaying else tick.state, interrupted=True, boundary=self.now
            )
        events = []
        epoch = (tick.segment_id, tick.eligible_since_backend_ms)
        if epoch != self._epoch:
            events += self._break("new playback segment", interrupted=True)
            self._epoch = epoch
            self._fresh_since = max(self._fresh_since, tick.eligible_since_backend_ms)
        e, c = tick.evidence, self.config
        if e is None or not e.usable or e.score is None:
            return events + self._break("missing or unusable signal", boundary=self.now)
        if e.end_backend_ms > self.now or self.now - e.end_backend_ms > c.stale_after_ms:
            return events + self._break("future or stale evidence", boundary=self.now)
        if e.start_backend_ms < self._fresh_since:
            return events + self._break("waiting for complete in-epoch evidence")
        span = e.media_range
        if (
            span.end_media_s > self.duration_s
            or span.end_media_s > tick.media_s + 0.05
            or abs(
                (span.end_media_s - span.start_media_s)
                - (e.end_backend_ms - e.start_backend_ms) * tick.playback_rate / 1000
            )
            > 0.05
        ):
            return events + self._break("invalid pre-mapped playback range", boundary=self.now)
        if e.evidence_id in self._seen_evidence or (
            self._last_end is not None and e.end_backend_ms <= self._last_end
        ):
            return events + self.poll(self.now)
        self._seen_evidence.add(e.evidence_id)
        if not self._remember(span):
            return events + self._break("previously observed media range", interrupted=True)
        if (self._last_end is not None and e.end_backend_ms - self._last_end > c.max_evidence_step_ms) or (
            self._last_source is not None and e.source != self._last_source
        ):
            events += self._break("evidence gap or source change")
        dt = e.end_backend_ms - self._last_end if self._last_end is not None else 0.0
        alpha = 1.0 if c.smoothing_tau_ms == 0 else -math.expm1(-dt / c.smoothing_tau_ms)
        self._smoothed = (
            e.score if self._smoothed is None else self._smoothed + alpha * (e.score - self._smoothed)
        )
        self._last_end, self._last_source = e.end_backend_ms, e.source
        level = self._level(self._smoothed)
        self.status = {
            "level": level,
            "state": "usable",
            "reason": "prototype estimate",
            "score": self._smoothed,
            "source": e.source,
        }
        events.append(self._event("attention_estimate", dict(self.status, backendMs=self.now)))
        if self._smoothed <= c.low_attention_max:
            self._recovery_since = None
            if self._pending is None:
                self._pending, self._worst = e, level
            if level == "no attention":
                self._worst = level
            if (
                self._active_segment is not None
                or e.end_backend_ms - self._pending.end_backend_ms >= c.minimum_loss_ms
            ):
                events += self._record_loss(e, level)
        elif self._active_segment is not None:
            if self._smoothed >= c.recovery_min:
                if self._recovery_since is None:
                    self._recovery_since = e.end_backend_ms
                if e.end_backend_ms - self._recovery_since >= c.recovery_ms:
                    events += self._close_segment()
                    self._pending = self._recovery_since = None
            else:
                self._recovery_since = None
        else:
            self._pending = None
        return events + self.poll(self.now)

    def poll(self, now_backend_ms: float) -> list[dict]:
        self._clock(now_backend_ms)
        events = []
        if (
            not self.ended
            and self._last_end is not None
            and self.now - self._last_end > self.config.stale_after_ms
        ):
            events += self._break("signal became stale", boundary=self.now)
        if not self.ended and self.config.question_timing == "end_of_lecture":
            return events
        allowed = self.ended or (
            self._playing and self.now - self._last_playback_ms <= self.config.stale_after_ms
        )
        allowed = allowed and not self._replaying
        question = self.questions.poll(self.now, self.segments, allowed=allowed)
        return events + (
            [self._event("question_request", question.model_dump(mode="json", by_alias=True))]
            if question
            else []
        )

    def request_replay(self, segment_id: str, action_id: str, now_backend_ms: float) -> list[dict]:
        """Explicit user replay, also available in normal mode without a question."""
        if action_id in self._replay_actions:
            if self._replay_actions[action_id] != segment_id:
                raise ValueError("replay action ID reused for another segment")
            return []
        segment = self.segments[segment_id]
        self._clock(now_backend_ms)
        self._replay_actions[action_id] = segment_id
        self._replaying = True
        events = self._break("user requested review replay", interrupted=True, boundary=self.now)
        span = segment.media_range
        return [
            *events,
            self._event(
                "playback_command",
                {
                    "commandId": action_id,
                    "segmentId": segment_id,
                    "action": "replay_range",
                    "startMediaS": span.start_media_s,
                    "endMediaS": span.end_media_s,
                },
            ),
        ]

    def act(self, action: QuestionAction) -> list[dict]:
        if action.action_id in self._actions:
            if action != self._actions[action.action_id]:
                raise ValueError("action ID reused with different content")
            return []
        q = self.questions.requests[action.question_id]
        self._clock(action.backend_ms)
        self._actions[action.action_id] = action
        if self.questions.states[q.question_id] in ("answered", "dismissed"):
            return []
        self.questions.presented(q.question_id, self.now)
        if action.action == "presented":
            return []
        if action.action == "replay":
            return self.request_replay(q.segment_id, action.action_id, self.now)
        self.questions.resolve(q.question_id, action.action, self.now, action.answer)
        # Do not change the attention label or cooldown following an answer/dismissal.
        return [
            self._event(
                "question_feedback",
                {"questionId": q.question_id, "action": action.action, "backendMs": self.now},
            )
        ]
