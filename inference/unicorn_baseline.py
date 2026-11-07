"""Session-local EEG spectral-change model, NOT a validated attention classifier.

Baseline is learned only from usable, eligible lecture playback. A large,
sustained deviation can suggest review; it cannot establish an attention lapse.
No electrode names or EEGMAT class labels are reinterpreted here.
"""

import math

from oxford_hack.contracts.payloads import EegFeature

from .live_attention import LiveAttentionConfig, LiveAttentionInference

BANDS = (("theta", 4, 8), ("alpha", 8, 13), ("beta", 13, 30))
FEATURE_SET = "unicorn-spectral-0.1.0"
PRODUCER = "unicorn-spectral-source"


def spectral_values(samples, rate):
    import numpy as np
    from scipy.signal import welch

    values = np.asarray(samples)
    if values.ndim != 2 or len(values) < rate * 2 - 1 or not np.isfinite(values).all():
        raise ValueError("complete finite two-second EEG window required")
    if rate < 100 or values.shape[1] == 0:
        raise ValueError("unsupported sampling rate or no EEG channels")
    f, power = welch(values, fs=rate, nperseg=int(rate * 2), axis=0)
    total = power[(f >= 4) & (f < 30)].sum(axis=0)
    if np.any(total <= 0):
        raise ValueError("no usable EEG spectral power")
    return np.stack(
        [
            np.log(
                np.maximum(power[(f >= low) & (f < high)].sum(axis=0) / total, 1e-12)
            )
            for _, low, high in BANDS
        ],
        axis=1,
    )


class FocusedBaseline:
    def __init__(self):
        self.mean = self.scale = None
        self.rows = []
        self.first_end = self.last_end = None
        self.last_score = None

    def reset_if_unfitted(self):
        if self.mean is None:
            self.rows.clear()
            self.first_end = self.last_end = None
            self.last_score = None

    def score(self, end, values):
        import numpy as np

        values = np.asarray(values, dtype=float)
        if not np.isfinite(values).all() or not values.size:
            raise ValueError("missing spectral features")
        if self.last_end is not None and end <= self.last_end:
            return self.last_score
        if self.mean is None:
            if self.last_end is not None and end - self.last_end > 2000:
                self.reset_if_unfitted()
            if self.first_end is None:
                self.first_end = end
            self.rows.append(values)
            # Bounded storage even for a misconfigured high-rate source.
            if len(self.rows) > 128:
                self.rows.pop(0)
            if end - self.first_end >= 8000:
                self.mean = np.mean(self.rows, axis=0)
                self.scale = np.maximum(np.std(self.rows, axis=0), 0.25)
                self.rows.clear()
        self.last_end = end
        if self.mean is None:
            return None
        if values.shape != self.mean.shape:
            raise ValueError("EEG channel geometry changed; start a new session")
        deviation = float(np.sqrt(np.mean(((values - self.mean) / self.scale) ** 2)))
        self.last_score = 100 * math.exp(-0.5 * (deviation / 3) ** 2)
        return self.last_score


class UnicornBaselineInference(LiveAttentionInference):
    def __init__(self, context):
        super().__init__(
            context,
            LiveAttentionConfig(
                feature_set_version=FEATURE_SET,
                producer=PRODUCER,
                feature_name="baseline_similarity",
            ),
        )
        self.baseline = FocusedBaseline()
        self._geometry = None

    def on_eeg_window(self, window):
        geometry = (window.stream_id, tuple(window.channels))
        if self._geometry is not None and self._geometry != geometry:
            self.baseline = FocusedBaseline()
            self._episode_reported = False
        self._geometry = geometry
        super().on_eeg_window(window)

    def on_eligibility(self, eligibility):
        if (
            self._eligibility is None
            or self._eligibility.epoch != eligibility.epoch
            or not eligibility.eligible
        ):
            self.baseline.reset_if_unfitted()
        super().on_eligibility(eligibility)

    def _unknown(self, reason):
        self.baseline.reset_if_unfitted()
        return super()._unknown(reason)

    def score_features(self, window):
        features = {(f.channel, f.name): f for f in window.features}
        values = []
        for channel in window.channels:
            for name, _, _ in BANDS:
                feature = features.get((channel, f"log_relative_{name}"))
                if (
                    feature is None
                    or feature.unit != "log_relative_power"
                    or feature.value is None
                ):
                    return []
                values.append(feature.value)
        try:
            score = self.baseline.score(window.evidence.end_backend_ms, values)
        except ValueError:
            return []
        if score is None:
            return None
        return [
            EegFeature(
                name="baseline_similarity",
                unit="score_0_100",
                channel=None,
                value=score,
                missing_reason=None,
            )
        ]


def inference_factory(context):
    from .live_combined import CombinedUnicornBaseline

    return (
        (
            CombinedUnicornBaseline(context)
            if context.gaze_enabled
            else UnicornBaselineInference(context)
        )
        if context.run_kind == "live" and context.eeg_enabled
        else None
    )
