"""Live EEG score-to-reminder adapter. Does not manufacture EEG features.

Only an explicitly named lecture-attention model output is accepted. Workload,
stub and synthetic feature sets remain unknown. Experimental policy opt-in is
the platform's responsibility; evaluated_modes deliberately stays empty.
"""

import math
from dataclasses import dataclass
from uuid import NAMESPACE_URL, uuid5

from oxford_hack.contracts.payloads import (
    BackendInterval,
    ContributingSignal,
    DetectorInfo,
    Provenance,
    ReviewCandidate,
    SignalScore,
)

from .adapter import InferenceStatus


@dataclass(frozen=True)
class LiveAttentionConfig:
    feature_set_version: str = "lecture-attention-0.1.0"
    producer: str = "lecture-attention-model"
    feature_name: str = "attention_score"
    feature_unit: str = "score_0_100"
    low_max: float = 30.0
    recovery_min: float = 45.0
    smoothing_ms: float = 5000.0
    dwell_ms: float = 8000.0
    recovery_ms: float = 4000.0
    cooldown_ms: float = 30000.0
    max_step_ms: float = 2000.0
    max_age_ms: float = 2000.0
    max_clock_uncertainty_ms: float = 50.0
    boundary_margin_ms: float = 300.0

    def __post_init__(self):
        values = (
            self.low_max,
            self.recovery_min,
            self.smoothing_ms,
            self.dwell_ms,
            self.recovery_ms,
            self.cooldown_ms,
            self.max_step_ms,
            self.max_age_ms,
            self.max_clock_uncertainty_ms,
            self.boundary_margin_ms,
        )
        if any(not math.isfinite(v) for v in values):
            raise ValueError("live reminder parameters must be finite")
        if not 0 <= self.low_max < self.recovery_min <= 100:
            raise ValueError("recovery must exceed the low-score threshold")
        if (
            any(v < 0 for v in values[2:])
            or min(self.dwell_ms, self.max_step_ms, self.max_age_ms) <= 0
        ):
            raise ValueError("invalid reminder durations")
        if self.cooldown_ms < 30000:
            raise ValueError(
                "automatic reminders must be at least thirty seconds apart"
            )


class LiveAttentionInference:
    """One session, EEG-only reminders using backend-mapped evidence timestamps."""

    evaluated_modes = frozenset()
    experimental_modes = frozenset({"eeg_only"})
    detector = DetectorInfo(
        detector_id="experimental-live-eeg-reminders",
        detector_version="0.1.0",
        config_version="eight-second-v1",
    )

    def __init__(self, context, config=None):
        self.context, self.config = context, config or LiveAttentionConfig()
        self.status = InferenceStatus(
            "unknown", "waiting for a live lecture-attention model"
        )
        self._eligibility = self._sensors = self._window = None
        self._last_end = self._smoothed = self._pending_end = self._pending_start = None
        self._recovery_since = None
        self._ids = {}
        self._episode_reported = False
        self._last_event_ms = -math.inf
        self._closed = False

    def _reset(self):
        self._last_end = self._smoothed = self._pending_end = self._pending_start = None
        self._recovery_since = None
        self._ids.clear()

    def _unknown(self, reason):
        self._reset()
        self.status = InferenceStatus("unknown", reason)
        return []

    def on_eligibility(self, eligibility):
        old = self._eligibility
        if old is not None and eligibility.epoch < old.epoch:
            return
        if old is None or eligibility != old:
            # Receipt timestamps may change without a new eligibility epoch.
            if (
                old is None
                or eligibility.epoch != old.epoch
                or not eligibility.eligible
                or eligibility.segment_id != old.segment_id
                or eligibility.eligible_since_backend_ms
                != old.eligible_since_backend_ms
            ):
                self._reset()
                self._window = None
        self._eligibility = eligibility
        if not eligibility.eligible:
            self.status = InferenceStatus("interrupted", eligibility.reason)

    def on_sensor_status(self, status):
        if self._sensors is None or status.t_backend_ms >= self._sensors.t_backend_ms:
            self._sensors = status
            if status.eeg.state != "ok":
                self._unknown("EEG is unavailable or unusable")

    def on_eeg_window(self, window):
        if self._window is not None and window.stream_id != self._window.stream_id:
            self._unknown("EEG stream changed; waiting for fresh evidence")
            self._window = None
        if (
            self._window is None
            or window.evidence.end_backend_ms > self._window.evidence.end_backend_ms
        ):
            self._window = window

    def on_gaze(self, observations):
        pass  # This adapter never claims a combined/gaze result.

    def on_gaze_calibration(self, calibration):
        pass

    def score_features(self, window):
        return window.features

    def poll(self, now_backend_ms):
        if self._closed:
            return []
        if not math.isfinite(now_backend_ms) or now_backend_ms < 0:
            return self._unknown("invalid backend time")
        e, w, c = self._eligibility, self._window, self.config
        if e is None or not e.eligible:
            self._reset()
            self.status = InferenceStatus(
                "interrupted", e.reason if e else "not_started"
            )
            return []
        if (
            self.context.run_kind != "live"
            or not self.context.eeg_enabled
            or e.video_id != self.context.video_id
        ):
            return self._unknown("live EEG session required")
        if self._sensors is None or self._sensors.eeg.state != "ok" or w is None:
            return self._unknown("waiting for usable live EEG")
        start, end = w.evidence.start_backend_ms, w.evidence.end_backend_ms
        if (
            w.provenance.run_kind != "live"
            or w.provenance.producer != c.producer
            or w.feature_set_version != c.feature_set_version
        ):
            return self._unknown(
                "lecture-attention model output unavailable; stub/workload input rejected"
            )
        quality = {q.channel: q for q in w.quality.channels}
        if (
            not w.quality.usable
            or w.quality.flags
            or not w.channels
            or len(set(w.channels)) != len(w.channels)
            or w.samples.expected <= 0
            or w.samples.received != w.samples.expected
            or any(
                name not in quality
                or quality[name].state != "good"
                or quality[name].flags
                for name in w.channels
            )
        ):
            return self._unknown("EEG quality or complete-window coverage failed")
        uncertainty = w.clock_correction.uncertainty_ms
        if (
            uncertainty is None
            or not 0 <= uncertainty <= c.max_clock_uncertainty_ms
            or start < (e.eligible_since_backend_ms or 0) + c.boundary_margin_ms
            or end <= start
            or end > now_backend_ms
            or w.t_processed_backend_ms > now_backend_ms
            or now_backend_ms - end > c.max_age_ms
        ):
            return self._unknown("EEG clock, age or playback eligibility failed")
        features = self.score_features(w)
        if features is None:
            self.status = InferenceStatus(
                "calibrating", "focus on the lecture for eight seconds of usable EEG"
            )
            return []
        scores = [
            f
            for f in features
            if (f.name, f.unit, f.channel) == (c.feature_name, c.feature_unit, None)
        ]
        if (
            len(scores) != 1
            or scores[0].value is None
            or not 0 <= scores[0].value <= 100
        ):
            return self._unknown("valid named lecture-attention score unavailable")
        if self._last_end is not None and end <= self._last_end:
            return []
        if self._last_end is not None and end - self._last_end > c.max_step_ms:
            self._reset()
        dt = end - self._last_end if self._last_end is not None else 0
        alpha = 1 if c.smoothing_ms == 0 else -math.expm1(-dt / c.smoothing_ms)
        value = scores[0].value
        self._smoothed = (
            value
            if self._smoothed is None
            else self._smoothed + alpha * (value - self._smoothed)
        )
        self._last_end = end
        self.status = InferenceStatus(
            "ready", "experimental live EEG estimate; not validated attention"
        )
        if self._smoothed >= c.recovery_min:
            if self._recovery_since is None:
                self._recovery_since = end
            if end - self._recovery_since >= c.recovery_ms:
                self._pending_end = self._pending_start = None
                self._ids.clear()
                self._episode_reported = False
            return []
        self._recovery_since = None
        if self._episode_reported:
            return []
        if self._smoothed > c.low_max and self._pending_end is None:
            return []
        if self._pending_end is None:
            self._pending_end, self._pending_start = end, start
        self._ids[w.window_id] = None
        if end - self._pending_end < c.dwell_ms:
            self.status = InferenceStatus(
                "pending", "waiting for eight seconds of sustained low estimates"
            )
            return []
        if now_backend_ms - self._last_event_ms < c.cooldown_ms:
            self.status = InferenceStatus(
                "cooldown", "recent reminder; review moments remain available"
            )
            return []
        self._last_event_ms = now_backend_ms
        self._episode_reported = True
        event = ReviewCandidate(
            event_id=uuid5(
                NAMESPACE_URL, f"live-eeg:{self.context.session_id}:{e.epoch}:{end}"
            ).hex,
            detector=self.detector,
            mode="eeg_only",
            evidence=BackendInterval(
                start_backend_ms=self._pending_start, end_backend_ms=end
            ),
            decision_backend_ms=now_backend_ms,
            eligibility_epoch=e.epoch,
            contributing_signals=[
                ContributingSignal(
                    signal="eeg",
                    window_ids=list(self._ids),
                    scores=[
                        SignalScore(
                            name=c.feature_name,
                            value=self._smoothed,
                            scale=c.feature_unit,
                            missing_reason=None,
                        )
                    ],
                )
            ],
            provenance=Provenance(
                run_kind="live",
                producer="experimental-live-eeg-reminders",
                producer_version="0.1.0",
            ),
        )
        self._pending_end = self._pending_start = None
        self._ids.clear()
        self.status = InferenceStatus("ready", "experimental live EEG reminder emitted")
        return [event]

    def close(self):
        self._closed = True
        self._reset()
        self.status = InferenceStatus("closed", "session ended")


def inference_factory(context):
    from .live_combined import CombinedLiveAttention

    return (
        (
            CombinedLiveAttention(context)
            if context.gaze_enabled
            else LiveAttentionInference(context)
        )
        if context.run_kind == "live" and context.eeg_enabled
        else None
    )
