"""Personal baseline over actual named model outputs; persists summaries only."""

from dataclasses import replace

from oxford_hack.contracts.payloads import DetectorInfo

from .calibration import CalibrationMemory, calibration_statistics
from .live_combined import CombinedLiveAttention


class PersonalizedAttention(CombinedLiveAttention):
    detector = DetectorInfo(
        detector_id="experimental-live-eeg-personal-reminders",
        detector_version="0.1.0",
        config_version="personal-model-v1",
    )

    def __init__(self, context, memory=None):
        super().__init__(context)
        self.config = replace(self.config, smoothing_ms=2500)
        self.memory = memory or CalibrationMemory()
        self.participant = "local"
        self.signature = None
        self.profile = None
        self.collecting = False
        self.samples = []
        self.sample_start = self.sample_end = None
        self.raw_model = None
        self._very_low = False
        self.calibration_message = "Waiting for Annie's model output"

    def _unknown(self, reason):
        if self.collecting:
            self.samples = []
            self.sample_start = self.sample_end = None
        return super()._unknown(reason)

    def calibration_action(self, action, participant="local"):
        if not isinstance(participant, str) or not 1 <= len(participant.strip()) <= 64:
            raise ValueError("Use a local profile name of 1–64 characters")
        if participant.strip() != self.participant:
            self.participant = participant.strip()
            self.profile = (
                self.memory.load(self.participant, self.signature)
                if self.signature
                else None
            )
        self._reset()
        self.samples = []
        self.sample_start = self.sample_end = None
        self.collecting = action == "start"
        if action == "reset":
            if self.signature:
                self.memory.reset(self.participant, self.signature)
            self.profile = None
        self.calibration_message = (
            "Watch the lecture attentively for 20 seconds of usable model output"
            if self.collecting
            else "Calibration reset"
            if action == "reset"
            else "Saved personal calibration loaded"
            if self.profile
            else "Waiting for model output to check saved calibration"
        )

    def score_features(self, window):
        signature = [
            window.provenance.producer,
            window.provenance.producer_version,
            window.feature_set_version,
            window.samples.expected,
            list(window.channels),
            [[f.name, f.unit, f.channel] for f in window.features],
        ]
        if self.signature != signature:
            self.signature = signature
            self.profile = self.memory.load(self.participant, signature)
            self.samples = []
            self.sample_start = self.sample_end = None
            self.calibration_message = (
                "Saved personal calibration loaded"
                if self.profile
                else "Personal calibration required"
            )
        raw = [
            f.value
            for f in window.features
            if (f.name, f.unit, f.channel)
            == (self.config.feature_name, self.config.feature_unit, None)
        ]
        if len(raw) != 1 or raw[0] is None or not 0 <= raw[0] <= 100:
            self._reset()
            self.calibration_message = "Model output or confidence unavailable"
            return []
        self.raw_model = raw[0]
        # Validate calibrated gaze coverage before accepting calibration samples.
        combined = super().score_features(window)
        if self.collecting and self._combine and combined is not None:
            gaze = self._gaze_reader._gaze_score(
                window.evidence.start_backend_ms, window.evidence.end_backend_ms
            )
            if gaze is None or gaze.scores[0].value > 0.2:
                combined = None
                self.calibration_message = (
                    "Look at the lecture during personal calibration"
                )
        if combined is None:
            self.samples = []
            self.sample_start = self.sample_end = None
            return None
        end = window.evidence.end_backend_ms
        if self.collecting and (self.sample_end is None or end > self.sample_end):
            if self.sample_end is not None and end - self.sample_end > 2000:
                self.samples = []
                self.sample_start = None
            if self.sample_start is None:
                self.sample_start = end
            # Calibrate thresholds in model score space; gaze never changes this baseline.
            self.samples.append(self.raw_model)
            self.sample_end = end
            if end - self.sample_start >= 20000 and len(self.samples) >= 30:
                try:
                    profile = calibration_statistics(self.samples)
                    self.memory.save(self.participant, self.signature, profile)
                    self.profile = profile
                    self.calibration_message = "Personal calibration saved"
                except (ValueError, OSError) as error:
                    self.calibration_message = str(error)
                self.collecting = False
                self.samples = []
                self._reset()
        if self.collecting or self.profile is None:
            return None
        self.config = replace(
            self.config,
            low_max=self.profile["low"],
            recovery_min=self.profile["recovery"],
        )
        # Primary model score drives the state. Gaze acts as corroboration in poll,
        # rather than changing the scale/meaning of Annie's output.
        return window.features

    def poll(self, now_backend_ms):
        pending = (
            self._pending_end,
            self._pending_start,
            dict(self._ids),
            self._last_event_ms,
        )
        events = super().poll(now_backend_ms)
        if self.collecting or (
            self.profile is None and self.status.state == "calibrating"
        ):
            self.status = type(self.status)("calibrating", self.calibration_message)
        # A calibrated camera must corroborate a low episode (>= 50% look-away).
        # Never generate an event purely from gaze or from missing model values.
        accepted = [
            e
            for e in events
            if e.mode != "both"
            or any(
                s.signal == "gaze" and s.scores[0].value >= 0.5
                for s in e.contributing_signals
            )
        ]
        if events and not accepted:
            self._pending_end, self._pending_start, self._ids, self._last_event_ms = (
                pending
            )
            self._episode_reported = False
            self.status = type(self.status)(
                "pending", "Low model estimate; waiting for gaze corroboration"
            )
        return [
            event.model_copy(
                update={
                    "contributing_signals": [
                        signal.model_copy(
                            update={
                                "scores": [
                                    score.model_copy(
                                        update={
                                            "name": "personal_smoothed_model_score",
                                            "scale": "score_0_100",
                                        }
                                    )
                                    if score.name == "combined_focus_score"
                                    else score
                                    for score in signal.scores
                                ]
                            }
                        )
                        for signal in event.contributing_signals
                    ]
                }
            )
            for event in accepted
        ]

    def snapshot(self):
        valid = self.status.state in {"ready", "pending", "cooldown"}
        score = self._smoothed if valid else None
        if score is None or self.profile is None:
            self._very_low = False
        elif score <= self.profile["veryLow"]:
            self._very_low = True
        elif score >= self.profile["veryLow"] + max(3, self.profile["std"] * 0.5):
            self._very_low = False
        level = (
            "unavailable"
            if score is None
            else "very low"
            if self._very_low
            else "low"
            if self._pending_end is not None
            or self._episode_reported
            or (self.profile and score <= self.profile["low"])
            else "within baseline"
        )
        return {
            "state": self.status.state,
            "reason": self.status.reason,
            "raw": self.raw_model if valid or self.collecting else None,
            "score": score,
            "level": level,
            "profile": self.profile,
            "participant": self.participant,
            "calibrating": self.collecting,
            "progress": min(1, (self.sample_end - self.sample_start) / 20000)
            if self.sample_end is not None and self.sample_start is not None
            else 0,
            "calibrationMessage": self.calibration_message,
            "threshold": self.config.low_max,
            "endBackendMs": self._last_end,
        }


def inference_factory(context):
    return (
        PersonalizedAttention(context)
        if context.run_kind == "live" and context.eeg_enabled
        else None
    )
