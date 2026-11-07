"""Live, backend-clock EEG/gaze combination over the existing live EEG gates.

No scripted source or browser/evaluator clock shortcut is used. Until the user
calibrates gaze the existing EEG-only mode is retained; after opting in, missing
gaze is unknown rather than silently falling back to EEG-only reminders.
"""

from oxford_hack.contracts.payloads import DetectorInfo, EegFeature, SignalScore

from .adapter import BaselineInference, InferenceStatus
from .live_attention import LiveAttentionInference
from .unicorn_baseline import UnicornBaselineInference


class CombinedGazeMixin:
    experimental_modes = frozenset({"eeg_only", "both"})
    detector = DetectorInfo(
        detector_id="experimental-live-eeg-gaze-reminders",
        detector_version="0.1.0",
        config_version="eight-second-combined-v1",
    )

    def __init__(self, context, *args, **kwargs):
        super().__init__(context, *args, **kwargs)
        # Reuse the existing mapped-time gaze coverage/calibration validator.
        # Its synthetic detector poll is never called.
        self._gaze_reader = BaselineInference(context)
        self._combine = False
        self._gaze_reason = None

    def on_gaze(self, observations):
        self._gaze_reader.on_gaze(observations)

    def on_gaze_calibration(self, calibration):
        self._gaze_reader.on_gaze_calibration(calibration)
        if self.context.gaze_enabled and calibration.status in {"in_progress", "valid"}:
            self._combine = True
        if self._combine:
            self._reset()

    def on_eligibility(self, eligibility):
        self._gaze_reader.on_eligibility(eligibility)
        super().on_eligibility(eligibility)

    def on_sensor_status(self, status):
        self._gaze_reader.on_sensor_status(status)
        super().on_sensor_status(status)

    def score_features(self, window):
        self._gaze_reason = None
        if not self._combine:
            return super().score_features(window)
        gaze = self._gaze_reader._gaze_score(
            window.evidence.start_backend_ms, window.evidence.end_backend_ms
        )
        if self._sensors.gaze.state != "ok" or gaze is None:
            if hasattr(self, "baseline"):
                self.baseline.reset_if_unfitted()
            self._reset()
            self._gaze_reason = "waiting for calibrated, continuous live gaze"
            return None
        away = gaze.scores[0].value
        if hasattr(self, "baseline") and self.baseline.mean is None and away > 0.2:
            self.baseline.reset_if_unfitted()
            self._reset()
            self._gaze_reason = (
                "watch the lecture normally to calibrate the EEG baseline"
            )
            return None
        eeg = super().score_features(window)
        if eeg is None or not eeg:
            return eeg
        scores = [
            f
            for f in eeg
            if (f.name, f.unit, f.channel)
            == (self.config.feature_name, self.config.feature_unit, None)
        ]
        if (
            len(scores) != 1
            or scores[0].value is None
            or not 0 <= scores[0].value <= 100
        ):
            return []
        self._raw_eeg = scores[0].value
        combined = 0.6 * scores[0].value + 0.4 * (1 - away) * 100
        return [
            EegFeature(
                name=self.config.feature_name,
                unit=self.config.feature_unit,
                channel=None,
                value=combined,
                missing_reason=None,
            )
        ]

    def poll(self, now_backend_ms):
        events = super().poll(now_backend_ms)
        if self._gaze_reason:
            self.status = InferenceStatus("unknown", self._gaze_reason)
        if not self._combine:
            return events
        combined = []
        for event in events:
            gaze = self._gaze_reader._gaze_score(
                event.evidence.start_backend_ms, event.evidence.end_backend_ms
            )
            if gaze is None:
                self._unknown("incomplete gaze coverage over the reminder interval")
                continue
            eeg = event.contributing_signals[0].model_copy(
                update={
                    "scores": [
                        SignalScore(
                            name=self.config.feature_name,
                            value=self._raw_eeg,
                            scale=self.config.feature_unit,
                            missing_reason=None,
                        ),
                        SignalScore(
                            name="combined_focus_score",
                            value=event.contributing_signals[0].scores[0].value,
                            scale="heuristic_0_100",
                            missing_reason=None,
                        ),
                    ]
                }
            )
            combined.append(
                event.model_copy(
                    update={
                        "mode": "both",
                        "contributing_signals": [eeg, gaze],
                    }
                )
            )
        return combined


class CombinedLiveAttention(CombinedGazeMixin, LiveAttentionInference):
    pass


class CombinedUnicornBaseline(CombinedGazeMixin, UnicornBaselineInference):
    pass
