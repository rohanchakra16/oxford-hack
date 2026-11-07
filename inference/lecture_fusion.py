"""Session-local prototype fusion; input scores are not attention probabilities.

Webcam calibration/quality belongs to gaze/. This layer only learns a focused
baseline from usable, pre-aligned EEG/gaze windows and combines their losses.
"""

from dataclasses import dataclass
from math import isfinite


@dataclass
class FocusFusion:
    baseline_ms: float = 8000.0
    eeg_weight: float = 0.6
    calibration_id: str | None = None
    baseline_eeg: float | None = None
    baseline_away: float | None = None
    collected_ms: float = 0.0
    _eeg_total: float = 0.0
    _away_total: float = 0.0
    eeg_score: float | None = None
    gaze_away: float | None = None
    combined_loss: float | None = None
    reason: str = "Calibrate the camera, then watch normally for 8 seconds."

    def interrupt(self) -> None:
        self.eeg_score = self.gaze_away = self.combined_loss = None
        if self.baseline_eeg is None:
            self.collected_ms = self._eeg_total = self._away_total = 0.0

    def combine(
        self,
        eeg_score: float | None,
        gaze_away: float | None,
        calibration_id: str | None,
        duration_ms: float,
    ) -> float | None:
        if (
            eeg_score is None
            or gaze_away is None
            or not calibration_id
            or not all(isfinite(x) for x in (eeg_score, gaze_away, duration_ms))
            or not 0 <= eeg_score <= 1
            or not 0 <= gaze_away <= 1
            or not 0 < duration_ms <= 2000
        ):
            self.interrupt()
            self.reason = "Waiting for usable EEG and calibrated gaze."
            return None
        if calibration_id != self.calibration_id:
            self.baseline_eeg = self.baseline_away = None
            self.interrupt()
            self.calibration_id = calibration_id
        self.eeg_score, self.gaze_away = eeg_score, gaze_away
        if self.baseline_eeg is None:
            if gaze_away > 0.2 or eeg_score < 0.5:
                self.interrupt()
                self.reason = (
                    "Watch the video normally to establish the focused baseline."
                )
                return None
            self.collected_ms += duration_ms
            self._eeg_total += eeg_score * duration_ms
            self._away_total += gaze_away * duration_ms
            self.reason = "Learning focused baseline; keep watching the video."
            if self.collected_ms >= self.baseline_ms:
                self.baseline_eeg = self._eeg_total / self.collected_ms
                self.baseline_away = self._away_total / self.collected_ms
                self.reason = "Baseline ready; combining EEG and gaze."
            # Baseline observations never double as loss evidence.
            return None
        eeg_loss = max(
            0.0,
            min(1.0, (self.baseline_eeg - eeg_score) / max(0.25, self.baseline_eeg)),
        )
        away_baseline = self.baseline_away or 0.0
        gaze_loss = max(
            0.0, min(1.0, (gaze_away - away_baseline) / max(0.5, 1 - away_baseline))
        )
        self.combined_loss = (
            self.eeg_weight * eeg_loss + (1 - self.eeg_weight) * gaze_loss
        )
        self.reason = "Combining baseline-adjusted EEG loss and calibrated look-away."
        return 1 - self.combined_loss

    def snapshot(self, threshold: float) -> dict:
        return {
            "calibrated": self.baseline_eeg is not None,
            "baselineProgress": min(1.0, self.collected_ms / self.baseline_ms),
            "eegWeight": self.eeg_weight,
            "gazeWeight": 1 - self.eeg_weight,
            "eegScore": self.eeg_score,
            "gazeAwayFraction": self.gaze_away,
            "combinedLoss": self.combined_loss,
            "threshold": threshold,
            "reason": self.reason,
        }
