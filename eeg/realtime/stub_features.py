"""Placeholder feature definitions; no EEG biomarker calculations are present."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import numpy as np

from .feature_types import FeatureResult


def _unavailable(
    eeg_window: np.ndarray,
    sampling_rate: float,
    channel_info: Mapping[str, Any],
    config: Mapping[str, Any] | None = None,
) -> FeatureResult:
    return FeatureResult(None, False, "Not implemented")


posterior_alpha_suppression = _unavailable
frontal_theta_power = _unavailable
theta_beta_ratio = _unavailable
engagement_index = _unavailable
beta_power = _unavailable
posterior_alpha_lateralisation = _unavailable

STUB_FEATURES = {
    "posterior_alpha_suppression": posterior_alpha_suppression,
    "frontal_theta_power": frontal_theta_power,
    "theta_beta_ratio": theta_beta_ratio,
    "engagement_index": engagement_index,
    "beta_power": beta_power,
    "posterior_alpha_lateralisation": posterior_alpha_lateralisation,
}

