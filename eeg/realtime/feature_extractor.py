"""Execution engine for registered EEG feature functions."""

from __future__ import annotations

import time
from collections.abc import Mapping
from typing import Any

import numpy as np

from .feature_types import FeatureResult
from .feature_registry import FeatureRegistry


class EEGFeatureExtractor:
    """Run all registered features independently for one preprocessed window."""

    def __init__(self, registry: FeatureRegistry) -> None:
        self.registry = registry

    def extract(
        self,
        eeg_window: np.ndarray,
        sampling_rate: float,
        channel_info: Mapping[str, Any],
        *,
        timestamp: float | None = None,
        config: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Return one extraction frame; one feature failure is isolated."""
        if not isinstance(sampling_rate, (int, float)) or sampling_rate <= 0:
            raise ValueError("sampling_rate must be positive")
        window = np.asarray(eeg_window)
        if window.ndim != 2:
            raise ValueError("eeg_window must have shape (sample_count, channel_count)")
        features: dict[str, dict[str, Any]] = {}
        execution_times: dict[str, float] = {}
        for name in self.registry.list_features():
            registered = self.registry.get(name)
            started = time.perf_counter()
            try:
                value = registered.function(
                    window,
                    float(sampling_rate),
                    channel_info,
                    registered.config if registered.config is not None else config,
                )
                result = _validate_result(value)
            except Exception as error:
                result = FeatureResult(None, False, str(error))
            execution_times[name] = (time.perf_counter() - started) * 1000.0
            features[name] = {
                "value": result.value,
                "valid": result.valid,
                **({"error": result.error} if result.error is not None else {}),
            }
        return {
            "timestamp": timestamp,
            "features": features,
            "execution_times_ms": execution_times,
            "overall_valid": bool(features) and all(
                item["valid"] for item in features.values()
            ),
        }


def _validate_result(value: Any) -> FeatureResult:
    if isinstance(value, FeatureResult):
        return value
    if value is None:
        raise ValueError("feature returned None without an explicit invalid result")
    return FeatureResult(value)
