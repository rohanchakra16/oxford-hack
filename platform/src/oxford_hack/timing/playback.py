"""Playback segment history and evidence-interval -> media-time mapping. Owner: Person 5.

A *segment* is one continuous interval of advancing frames at a constant playback rate, as
reported by the browser's PlaybackState telemetry (browser clock). Segments end on pause,
seek, buffering, rate change, source change, end of media, error, or a detected discontinuity.

Mapping converts a backend-clock evidence interval to browser time using the current clock
estimate, then requires the whole interval (plus a margin covering clock uncertainty) to lie
inside a single segment that telemetry has confirmed. We never interpolate across segments.
See docs/TIMING.md for the rules and their rationale.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..contracts.payloads import (
    BackendInterval,
    CandidateRejectionReason,
    EligibilityReason,
    MappingConfig,
    MediaInterval,
    PlaybackState,
)
from .clock_sync import ClockEstimate

DEFAULT_MAPPING = MappingConfig(
    lead_in_s=2.0,
    boundary_margin_ms=250.0,
    max_clock_uncertainty_ms=50.0,
    max_telemetry_staleness_ms=2_500.0,
    pending_timeout_ms=3_000.0,
    max_candidate_age_ms=30_000.0,
)
"""Default mapping settings sent in every SessionConfig."""

DISCONTINUITY_TOLERANCE_S = 0.5
"""A heartbeat whose media time differs from the segment's prediction by more than this ends the segment."""

_STATE_TO_REASON: dict[str, EligibilityReason] = {
    "loading": "not_started",
    "paused": "paused",
    "seeking": "seeking",
    "buffering": "buffering",
    "ended": "ended",
    "error": "error",
}


class TelemetryRejected(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class Anchor:
    browser_ms: float
    media_s: float


@dataclass
class Segment:
    segment_id: str
    video_id: str
    rate: float
    anchors: list[Anchor]
    last_telemetry_browser_ms: float
    last_telemetry_received_backend_ms: float
    end_browser_ms: float | None = None
    end_reason: str | None = None
    gaps: list[tuple[float, float]] = field(default_factory=list)

    @property
    def start_browser_ms(self) -> float:
        return self.anchors[0].browser_ms

    @property
    def is_open(self) -> bool:
        return self.end_browser_ms is None

    def media_at(self, t_browser_ms: float) -> float:
        anchor = self.anchors[0]
        for a in self.anchors:
            if a.browser_ms <= t_browser_ms:
                anchor = a
            else:
                break
        return anchor.media_s + (t_browser_ms - anchor.browser_ms) / 1000.0 * self.rate


@dataclass(frozen=True)
class MappedEvidence:
    video_id: str
    segment_id: str
    evidence_media: MediaInterval
    uncertainty_ms: float


@dataclass(frozen=True)
class MapOutcome:
    mapped: MappedEvidence | None = None
    rejection: CandidateRejectionReason | None = None
    detail: str = ""
    pending: bool = False


@dataclass(frozen=True)
class Eligibility:
    eligible: bool
    reason: EligibilityReason
    segment_id: str | None
    since_backend_ms: float | None


class PlaybackTimeline:
    """Segment history for one video in one session. Not thread-safe; owned by the hub loop."""

    def __init__(self, video_id: str, *, history_ms: float = 15 * 60_000.0) -> None:
        self.video_id = video_id
        self.history_ms = history_ms
        self.segments: list[Segment] = []
        self.media_duration_s: float | None = None
        self.last_state: str = "loading"
        self._last_seq: int | None = None
        self._last_browser_ms: float | None = None
        self._closed_ids: set[str] = set()
        self._broken_ids: set[str] = set()
        self.discontinuities = 0
        self.history_start_browser_ms: float | None = None

    @property
    def open_segment(self) -> Segment | None:
        if self.segments and self.segments[-1].is_open:
            return self.segments[-1]
        return None

    def ingest(self, state: PlaybackState, received_backend_ms: float, *, staleness_ms: float) -> None:
        """Apply one telemetry message. Raises TelemetryRejected for unusable telemetry."""
        if state.video_id != self.video_id:
            raise TelemetryRejected(
                "video_mismatch",
                f"telemetry for video {state.video_id!r} in a session "
                f"for {self.video_id!r}; start a new session",
            )
        if self._last_seq is not None and state.telemetry_seq <= self._last_seq:
            raise TelemetryRejected("out_of_order", f"telemetrySeq {state.telemetry_seq} <= {self._last_seq}")
        if self._last_browser_ms is not None and state.t_browser_ms < self._last_browser_ms:
            raise TelemetryRejected("out_of_order", "tBrowserMs went backwards")
        if state.segment_id is not None and (
            state.segment_id in self._closed_ids and state.segment_id not in self._broken_ids
        ):
            raise TelemetryRejected("out_of_order", f"segment {state.segment_id!r} already ended")
        self._last_seq = state.telemetry_seq
        self._last_browser_ms = state.t_browser_ms
        if state.media_duration_s is not None:
            self.media_duration_s = state.media_duration_s
        self.last_state = state.state
        t = state.t_browser_ms
        current = self.open_segment

        if state.state != "playing":
            if current is not None:
                self._close(current, t, state.event if state.event != "heartbeat" else state.state)
            return

        seg_id = state.segment_id
        assert seg_id is not None  # guaranteed by the contract
        if seg_id in self._broken_ids:
            return  # ignored until the browser starts a new segment
        if current is not None and current.segment_id == seg_id:
            predicted = current.media_at(t)
            if (
                abs(predicted - state.media_time_s) > DISCONTINUITY_TOLERANCE_S
                or state.playback_rate != current.rate
            ):
                self.discontinuities += 1
                self._close(current, current.last_telemetry_browser_ms, "discontinuity")
                self._broken_ids.add(seg_id)
                return
            if t - current.last_telemetry_browser_ms > staleness_ms:
                current.gaps.append((current.last_telemetry_browser_ms, t))
            current.anchors.append(Anchor(t, state.media_time_s))
            current.last_telemetry_browser_ms = t
            current.last_telemetry_received_backend_ms = received_backend_ms
            return
        if current is not None:
            self._close(current, t, "new_segment")
        self.segments.append(
            Segment(
                segment_id=seg_id,
                video_id=self.video_id,
                rate=state.playback_rate,
                anchors=[Anchor(t, state.media_time_s)],
                last_telemetry_browser_ms=t,
                last_telemetry_received_backend_ms=received_backend_ms,
            )
        )

    def _close(self, seg: Segment, t_browser_ms: float, reason: str) -> None:
        seg.end_browser_ms = max(t_browser_ms, seg.start_browser_ms)
        seg.end_reason = reason
        self._closed_ids.add(seg.segment_id)

    def prune(self, now_browser_ms: float) -> None:
        cutoff = now_browser_ms - self.history_ms
        kept = [s for s in self.segments if s.is_open or (s.end_browser_ms or 0) >= cutoff]
        if len(kept) != len(self.segments):
            self.history_start_browser_ms = cutoff
        self.segments = kept

    def eligibility(
        self, now_backend_ms: float, clock: ClockEstimate | None, cfg: MappingConfig
    ) -> Eligibility:
        seg = self.open_segment
        if seg is None:
            reason = _STATE_TO_REASON.get(self.last_state, "not_started")
            if self.segments and self.segments[-1].end_reason == "discontinuity":
                reason = "seeking"
            return Eligibility(False, reason, None, None)
        if clock is None or clock.uncertainty_ms > cfg.max_clock_uncertainty_ms:
            return Eligibility(False, "clock_unsynchronised", None, None)
        if now_backend_ms - seg.last_telemetry_received_backend_ms > cfg.max_telemetry_staleness_ms:
            return Eligibility(False, "stale_telemetry", None, None)
        since_browser = seg.gaps[-1][1] if seg.gaps else seg.start_browser_ms
        since = max(0.0, clock.browser_to_backend(since_browser))
        return Eligibility(True, "playing", seg.segment_id, since)

    def map_evidence(
        self, interval: BackendInterval, clock: ClockEstimate | None, cfg: MappingConfig
    ) -> MapOutcome:
        if clock is None:
            return MapOutcome(rejection="clock_unsynchronised", detail="no browser clock estimate yet")
        if clock.uncertainty_ms > cfg.max_clock_uncertainty_ms:
            return MapOutcome(
                rejection="clock_uncertain",
                detail=(
                    f"clock uncertainty {clock.uncertainty_ms:.1f} ms > {cfg.max_clock_uncertainty_ms:.0f} ms"
                ),
            )
        a = clock.backend_to_browser(interval.start_backend_ms)
        b = clock.backend_to_browser(interval.end_backend_ms)
        margin = clock.uncertainty_ms + cfg.boundary_margin_ms

        seg = next(
            (
                s
                for s in self.segments
                if s.start_browser_ms <= a and (s.end_browser_ms is None or a < s.end_browser_ms)
            ),
            None,
        )
        if seg is None:
            if self.history_start_browser_ms is not None and a < self.history_start_browser_ms:
                return MapOutcome(
                    rejection="history_expired", detail="evidence predates retained playback history"
                )
            return MapOutcome(
                rejection="not_playing", detail="evidence start is not inside a playing segment"
            )
        if a - seg.start_browser_ms < margin:
            return MapOutcome(
                rejection="crosses_boundary",
                detail=f"evidence starts within {margin:.0f} ms of segment {seg.segment_id} start",
            )
        if seg.end_browser_ms is not None:
            if b > seg.end_browser_ms - margin:
                return MapOutcome(
                    rejection="crosses_boundary",
                    detail=f"evidence extends past segment {seg.segment_id} end ({seg.end_reason})",
                )
        elif b + margin > seg.last_telemetry_browser_ms:
            return MapOutcome(pending=True, detail="waiting for telemetry confirming playback continued")
        for g0, g1 in seg.gaps:
            if a < g1 and b > g0:
                return MapOutcome(rejection="stale_telemetry", detail="evidence overlaps a telemetry gap")
        start_media = seg.media_at(a)
        end_media = seg.media_at(b)
        duration = self.media_duration_s
        if duration is not None and end_media > duration + 0.5:
            return MapOutcome(rejection="out_of_media_bounds", detail="mapped time beyond media duration")
        return MapOutcome(
            mapped=MappedEvidence(
                video_id=seg.video_id,
                segment_id=seg.segment_id,
                evidence_media=MediaInterval(
                    start_media_s=max(0.0, start_media), end_media_s=max(0.0, end_media)
                ),
                uncertainty_ms=clock.uncertainty_ms,
            )
        )
