"""Portable EEGMAT workload classifier. Its score is NOT measured attention.

The optional spectral transform consumes already preprocessed windows. Learned
normalisation and coefficients are stored in plain validated JSON, never pickle.
"""

import math
from collections.abc import Sequence
from pathlib import Path
from typing import Literal

from oxford_hack.contracts.base import Contract
from pydantic import Field, model_validator

CHANNELS = ("Fz", "Cz", "Pz")
BANDS = (("theta", 4.0, 8.0), ("alpha", 8.0, 13.0), ("beta", 13.0, 30.0))
FEATURE_NAMES = tuple(f"{ch}.log_relative_{band}" for ch in CHANNELS for band, _, _ in BANDS)
DEFAULT_MODEL = Path(__file__).parent / "bundles" / "eegmat-workload-0.1.0.json"


class WorkloadPrediction(Contract):
    state: Literal["ok", "unknown"]
    reason: str
    score: float | None = Field(default=None, ge=0, le=1)
    score_name: Literal["arithmetic_vs_rest"] = "arithmetic_vs_rest"
    scale: Literal["uncalibrated_probability"] = "uncalibrated_probability"
    live_automatic: Literal[False] = False


class WorkloadBundle(Contract):
    detector_id: Literal["eegmat-workload-proxy"] = "eegmat-workload-proxy"
    detector_version: Literal["0.1.0"] = "0.1.0"
    target: Literal["mental_arithmetic_vs_rest"] = "mental_arithmetic_vs_rest"
    feature_version: Literal["midline-log-relative-bandpower-1"] = "midline-log-relative-bandpower-1"
    channels: list[str]
    feature_names: list[str]
    sampling_rate_hz: Literal[250.0] = 250.0
    window_samples: Literal[1000] = 1000
    settling_samples: Literal[2500] = 2500
    threshold: Literal[0.5] = 0.5
    # Source-domain workload evaluation does not authorise lecture review events.
    evaluated_modes: list[str] = Field(default_factory=list, max_length=0)
    live_automatic: Literal[False] = False
    mean: list[float] = Field(min_length=9, max_length=9)
    scale: list[float] = Field(min_length=9, max_length=9)
    coefficients: list[float] = Field(min_length=9, max_length=9)
    intercept: float
    regularization_c: float = Field(gt=0)
    seed: int
    dataset: Literal["EEGMAT-1.0.0"] = "EEGMAT-1.0.0"
    source_revision: str = Field(pattern=r"^[0-9a-f]{40}$")
    source_hashes: dict[str, str]
    split_manifest_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")

    @model_validator(mode="after")
    def validate_transform(self) -> "WorkloadBundle":
        if self.channels != list(CHANNELS) or self.feature_names != list(FEATURE_NAMES):
            raise ValueError("channel/feature order must match the versioned model transform")
        if any(value <= 0 for value in self.scale):
            raise ValueError("normalisation scales must be positive")
        return self

    def predict_features(self, features: Sequence[float], *, usable: bool = True) -> WorkloadPrediction:
        if not usable:
            return WorkloadPrediction(state="unknown", reason="input quality unusable")
        if len(features) != len(self.mean) or any(not math.isfinite(x) for x in features):
            return WorkloadPrediction(state="unknown", reason="missing or non-finite model features")
        z = self.intercept + sum(
            weight * (value - mean) / scale
            for weight, value, mean, scale in zip(
                self.coefficients, features, self.mean, self.scale, strict=True
            )
        )
        score = 1.0 / (1.0 + math.exp(-z)) if z >= 0 else math.exp(z) / (1.0 + math.exp(z))
        return WorkloadPrediction(state="ok", reason="experimental source-domain workload proxy", score=score)


def load_workload_bundle(path: str | Path = DEFAULT_MODEL) -> WorkloadBundle:
    return WorkloadBundle.model_validate_json(Path(path).read_text(encoding="utf-8"))


def spectral_features(window, sampling_rate: float, channel_names: Sequence[str]):
    """Nine log relative band powers in channel-major order; no learned fit here.

    This is the model's offline input transform, not a replacement for Annie's
    registry stubs. Optional numpy/scipy dependencies are imported only on use.
    """
    import numpy as np
    from scipy.signal import welch

    data = np.asarray(window, dtype=np.float64)
    if sampling_rate != 250.0 or data.shape != (1000, len(channel_names)):
        raise ValueError("model requires a complete 4 s window at 250 Hz")
    if len(set(channel_names)) != len(channel_names):
        raise ValueError("duplicate channel names")
    if not all(channel in channel_names for channel in CHANNELS):
        raise ValueError("model requires named Fz, Cz and Pz electrodes, not channel-index guesses")
    data = data[:, [list(channel_names).index(channel) for channel in CHANNELS]]
    if not np.isfinite(data).all() or np.any(np.ptp(data, axis=0) <= 1e-12):
        raise ValueError("non-finite or flatline model input")
    frequencies, psd = welch(
        data,
        fs=250.0,
        window="hann",
        nperseg=500,
        noverlap=250,
        detrend="constant",
        scaling="density",
        axis=0,
    )
    total = psd[(frequencies >= 1.0) & (frequencies < 30.0)].sum(axis=0)
    if np.any(total <= 0):
        raise ValueError("zero spectral power")
    powers = np.stack(
        [psd[(frequencies >= low) & (frequencies < high)].sum(axis=0) / total for _, low, high in BANDS],
        axis=1,
    )
    return np.log(np.maximum(powers, 1e-12)).ravel()


def predict_window(
    model: WorkloadBundle, window, sampling_rate: float, channel_names: Sequence[str], *, usable: bool = True
) -> WorkloadPrediction:
    if not usable:
        return model.predict_features([], usable=False)
    try:
        features = spectral_features(window, sampling_rate, channel_names)
    except ValueError as error:
        return WorkloadPrediction(state="unknown", reason=str(error))
    return model.predict_features(features.tolist())
