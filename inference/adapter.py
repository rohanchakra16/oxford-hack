"""Conservative synthetic baseline implementing the platform's InferenceAdapter.

All evidence uses backend milliseconds. Media mapping stays with the hub.
EEG's synthetic scalar and gaze's outside-video duration are separate scores,
not attention probabilities. Combined mode requires both thresholds.
"""

from collections import deque
from collections.abc import Sequence
from dataclasses import dataclass
from math import isfinite
from uuid import NAMESPACE_URL, uuid5

from oxford_hack.contracts.base import AutomaticMode
from oxford_hack.contracts.payloads import (
    BackendInterval,
    ContributingSignal,
    DetectorInfo,
    EegFeatureWindow,
    GazeCalibration,
    PlaybackEligibility,
    Provenance,
    ReviewCandidate,
    SensorStatus,
    SignalScore,
)
from oxford_hack.inference.interface import MappedGazeObservation, SessionContext

from .model import ModelBundle, load_bundle


@dataclass(frozen=True)
class InferenceStatus:
    state: str
    reason: str


class BaselineInference:
    def __init__(self, context: SessionContext, bundle: ModelBundle | None = None):
        self.context = context
        self.bundle = bundle or load_bundle()
        self.status = InferenceStatus("unknown", "waiting for playback eligibility")
        self._eligibility: PlaybackEligibility | None = None
        self._sensors: SensorStatus | None = None
        self._calibration: GazeCalibration | None = None
        self._eeg: EegFeatureWindow | None = None
        self._gaze: deque[MappedGazeObservation] = deque(maxlen=4096)
        self._last_gaze_time = -1.0
        self._last_end = -1.0
        self._pending_since: float | None = None
        self._pending_start: float | None = None
        self._pending_ids: dict[str, dict[str, None]] = {}
        self._last_event_end = -float("inf")
        self._closed = False

    @property
    def detector(self) -> DetectorInfo:
        return self.bundle.detector

    @property
    def evaluated_modes(self) -> frozenset[AutomaticMode]:
        return frozenset()

    def _reset(self) -> None:
        self._eeg = None
        self._gaze.clear()
        self._last_gaze_time = -1.0
        self._last_end = -1.0
        self._clear_pending()

    def _clear_pending(self) -> None:
        self._pending_since = None
        self._pending_start = None
        self._pending_ids.clear()

    def _unknown(self, reason: str) -> list[ReviewCandidate]:
        self._clear_pending()
        self.status = InferenceStatus("unknown", reason)
        return []

    def on_eligibility(self, eligibility: PlaybackEligibility) -> None:
        old = self._eligibility
        if old is not None and eligibility.epoch < old.epoch:
            return
        if (
            old is None
            or eligibility.epoch != old.epoch
            or eligibility.segment_id != old.segment_id
            or not eligibility.eligible
            or eligibility.eligible_since_backend_ms != old.eligible_since_backend_ms
        ):
            self._reset()
        self._eligibility = eligibility
        if not eligibility.eligible:
            self.status = InferenceStatus("interrupted", eligibility.reason)

    def on_sensor_status(self, status: SensorStatus) -> None:
        if self._sensors is not None and status.t_backend_ms < self._sensors.t_backend_ms:
            return
        if self._sensors is None or status.mode != self._sensors.mode:
            self._reset()
        self._sensors = status

    def on_gaze_calibration(self, calibration: GazeCalibration) -> None:
        if self._calibration is not None and calibration.t_browser_ms < self._calibration.t_browser_ms:
            return
        if calibration != self._calibration:
            self._gaze.clear()
            self._clear_pending()
        self._calibration = calibration

    def on_eeg_window(self, window: EegFeatureWindow) -> None:
        if self._eeg is None or window.evidence.end_backend_ms > self._eeg.evidence.end_backend_ms:
            self._eeg = window
            if (
                self._eeg_score(
                    window.evidence.start_backend_ms,
                    window.evidence.end_backend_ms,
                    window.t_processed_backend_ms,
                )
                is None
            ):
                self._clear_pending()

    def on_gaze(self, observations: Sequence[MappedGazeObservation]) -> None:
        for mapped in observations:
            if isfinite(mapped.t_backend_frame_ms) and mapped.t_backend_frame_ms > self._last_gaze_time:
                self._last_gaze_time = mapped.t_backend_frame_ms
                self._gaze.append(mapped)

    def _eeg_score(self, start: float, end: float, now: float) -> ContributingSignal | None:
        w, b = self._eeg, self.bundle
        if (
            w is None
            or not w.quality.usable
            or w.quality.flags
            or w.provenance.run_kind != self.context.run_kind
            or w.evidence.start_backend_ms != start
            or w.evidence.end_backend_ms != end
            or w.t_processed_backend_ms > now
            or w.feature_set_version != b.eeg_feature_set_version
            or w.samples.expected == 0
            or w.samples.received != w.samples.expected
            or w.clock_correction.uncertainty_ms is None
            or w.clock_correction.uncertainty_ms > b.max_clock_uncertainty_ms
        ):
            return None
        features = [
            f
            for f in w.features
            if (f.name, f.unit, f.channel) == (b.eeg_feature_name, b.eeg_feature_unit, b.eeg_feature_channel)
        ]
        quality = [q for q in w.quality.channels if q.channel == b.eeg_feature_channel]
        if b.eeg_feature_channel is not None and (
            len(quality) != 1 or quality[0].state != "good" or quality[0].flags
        ):
            return None
        if len(features) != 1 or features[0].value is None:
            return None
        return ContributingSignal(
            signal="eeg",
            window_ids=[w.window_id],
            scores=[
                SignalScore(
                    name=b.eeg_feature_name,
                    value=features[0].value,
                    scale=b.eeg_feature_unit,
                    missing_reason=None,
                )
            ],
        )

    def _gaze_score(self, start: float, end: float) -> ContributingSignal | None:
        cal, b = self._calibration, self.bundle
        if (
            cal is None
            or cal.status != "valid"
            or cal.measurement_kind != "screen_gaze"
            or cal.provenance.run_kind != self.context.run_kind
            or cal.held_out_points == 0
            or cal.held_out_error_norm is None
        ):
            return None
        frames = [m for m in self._gaze if start <= m.t_backend_frame_ms <= end]
        if len(frames) < 2 or frames[0].t_backend_frame_ms - start > b.gaze_max_gap_ms:
            return None
        valid_ms = outside_ms = 0.0
        ids = []
        for i, mapped in enumerate(frames):
            stop = frames[i + 1].t_backend_frame_ms if i + 1 < len(frames) else end
            duration = stop - mapped.t_backend_frame_ms
            if duration > b.gaze_max_gap_ms:
                return None
            o = mapped.observation
            valid = (
                o.valid
                and o.measurement_kind == "screen_gaze"
                and o.calibration_id == cal.calibration_id
                and isfinite(mapped.clock_uncertainty_ms)
                and 0 <= mapped.clock_uncertainty_ms <= b.max_clock_uncertainty_ms
            )
            if valid:
                valid_ms += duration
                outside_ms += duration if o.inside_video is False else 0.0
                ids.append(o.observation_id)
        if valid_ms < b.gaze_min_valid_fraction * (end - start):
            return None
        return ContributingSignal(
            signal="gaze",
            window_ids=ids,
            scores=[
                SignalScore(
                    name="outside_video_fraction",
                    value=outside_ms / valid_ms,
                    scale="fraction_of_valid_duration",
                    missing_reason=None,
                )
            ],
        )

    def poll(self, now_backend_ms: float) -> list[ReviewCandidate]:
        if self._closed:
            return []
        if not isfinite(now_backend_ms) or now_backend_ms < 0:
            return self._unknown("invalid backend time")
        e, sensors, b = self._eligibility, self._sensors, self.bundle
        if e is None or not e.eligible:
            self._clear_pending()
            self.status = InferenceStatus("interrupted", e.reason if e else "not_started")
            return []
        if self.context.run_kind != "simulated":
            return self._unknown("synthetic-only bundle; live/replay modes unevaluated")
        if e.video_id != self.context.video_id:
            return self._unknown("video mismatch")
        if sensors is None or sensors.mode == "manual_only":
            return self._unknown("no usable sensor mode")
        mode = sensors.mode
        eeg_needed, gaze_needed = mode in ("both", "eeg_only"), mode in ("both", "gaze_only")
        if (eeg_needed and (not self.context.eeg_enabled or sensors.eeg.state != "ok")) or (
            gaze_needed and (not self.context.gaze_enabled or sensors.gaze.state != "ok")
        ):
            return self._unknown("requested sensor unavailable")
        if eeg_needed:
            if self._eeg is None:
                return self._unknown("waiting for EEG window")
            start, end = self._eeg.evidence.start_backend_ms, self._eeg.evidence.end_backend_ms
        else:
            if not self._gaze:
                return self._unknown("waiting for gaze window")
            end = self._gaze[-1].t_backend_frame_ms
            start = end - b.evidence_ms
        if (
            start < (e.eligible_since_backend_ms or 0.0)
            or end - start != b.evidence_ms
            or end > now_backend_ms
            or now_backend_ms - end > b.max_age_ms
        ):
            return self._unknown("incomplete, stale or out-of-epoch evidence")
        signals = []
        if eeg_needed:
            score = self._eeg_score(start, end, now_backend_ms)
            if score is None:
                return self._unknown("EEG feature/quality/clock mismatch")
            signals.append(score)
        if gaze_needed:
            score = self._gaze_score(start, end)
            if score is None:
                return self._unknown("gaze calibration/coverage/clock insufficient")
            signals.append(score)
        if end <= self._last_end:
            return []  # repeated polling cannot accumulate dwell or duplicate an event
        if end - self._last_end > b.max_step_ms:
            self._clear_pending()
        self._last_end = end
        high = all(
            s.scores[0].value >= (b.eeg_threshold if s.signal == "eeg" else b.gaze_outside_threshold)
            for s in signals
        )
        if not high:
            self._clear_pending()
            self.status = InferenceStatus("ready", "usable evidence below threshold")
            return []
        if end - self._last_event_end < b.cooldown_ms:
            self._clear_pending()
            self.status = InferenceStatus("cooldown", "recent review suggestion")
            return []
        if self._pending_since is None:
            self._pending_since = end
            self._pending_start = start
        for signal in signals:
            ids = self._pending_ids.setdefault(signal.signal, {})
            ids.update(dict.fromkeys(signal.window_ids))
        if end - self._pending_since < b.dwell_ms:
            self.status = InferenceStatus("pending", "waiting for sustained evidence")
            return []
        self._last_event_end = end
        evidence_start = self._pending_start
        assert evidence_start is not None
        signals = [
            ContributingSignal(signal=s.signal, window_ids=list(self._pending_ids[s.signal]), scores=s.scores)
            for s in signals
        ]
        self._clear_pending()
        event_id = uuid5(
            NAMESPACE_URL, f"{self.context.session_id}:{e.epoch}:{mode}:{end}:{self.detector}"
        ).hex
        self.status = InferenceStatus("ready", "experimental review suggestion emitted")
        return [
            ReviewCandidate(
                event_id=event_id,
                detector=self.detector,
                mode=mode,
                evidence=BackendInterval(start_backend_ms=evidence_start, end_backend_ms=end),
                decision_backend_ms=now_backend_ms,
                eligibility_epoch=e.epoch,
                contributing_signals=signals,
                provenance=Provenance(
                    run_kind=self.context.run_kind,
                    producer="experimental-rule-baseline",
                    producer_version=b.detector_version,
                ),
            )
        ]

    def close(self) -> None:
        self._reset()
        self._closed = True
        self.status = InferenceStatus("closed", "session ended")


def inference_factory(context: SessionContext) -> BaselineInference | None:
    """Injection point for the hub owner. This initial bundle is simulation-only."""
    return BaselineInference(context) if context.run_kind == "simulated" else None
