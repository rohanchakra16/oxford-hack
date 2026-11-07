"""Extensible attention-classification interfaces and a deterministic stub.

The stub is an experimental score mapper, not a trained or validated
attention model. It consumes already extracted feature values and never
calculates EEG features itself.
"""

from __future__ import annotations

from collections.abc import Mapping
from numbers import Real
from typing import Any


class AttentionClassifier:
    """Interface implemented by attention classifiers."""

    def predict(self, features: Mapping[str, Any]) -> dict[str, Any]:
        """Return a structured attention prediction for one feature frame."""
        raise NotImplementedError


class StubAttentionClassifier(AttentionClassifier):
    """Deterministic weighted score mapper for development and integration tests.

    Values are optionally baseline-normalized, multiplied by configured
    directions, averaged using feature weights, and linearly mapped to the
    configured score range. The result is not a probability or calibrated
    attention estimate.
    """

    def __init__(
        self,
        *,
        expected_features: tuple[str, ...] | list[str] | None = None,
        feature_weights: Mapping[str, float] | None = None,
        feature_directions: Mapping[str, float] | None = None,
        baselines: Mapping[str, Mapping[str, float]] | None = None,
        missing_feature_policy: str = "invalidate",
        score_mapping: Mapping[str, float] | None = None,
    ) -> None:
        self.expected_features = tuple(expected_features or ())
        self.feature_weights = dict(feature_weights or {})
        self.feature_directions = dict(feature_directions or {})
        self.baselines = dict(baselines or {})
        self.missing_feature_policy = missing_feature_policy
        mapping = dict(score_mapping or {"input_min": 0.0, "input_max": 1.0,
                                         "output_min": 0.0, "output_max": 100.0})
        self.score_mapping = mapping
        self._validate_configuration()

    def predict(self, features: Mapping[str, Any]) -> dict[str, Any]:
        """Produce a deterministic prediction from valid scalar feature values."""
        timestamp = features.get("timestamp") if isinstance(features, Mapping) else None
        frame_index = features.get("frame_index") if isinstance(features, Mapping) else None
        values = features.get("features", features) if isinstance(features, Mapping) else {}
        base = {
            "attention_score": None,
            "valid": False,
            "model_type": "stub",
            "confidence": 0.0,
            "timestamp": timestamp,
            "frame_index": frame_index,
        }
        if not isinstance(values, Mapping):
            return {**base, "reason": "Invalid feature input"}

        names = self.expected_features or tuple(values.keys())
        valid_values: dict[str, float] = {}
        missing: list[str] = []
        for name in names:
            item = values.get(name)
            if not isinstance(item, Mapping) or item.get("valid") is not True:
                missing.append(name)
                continue
            value = item.get("value")
            if isinstance(value, bool) or not isinstance(value, Real):
                missing.append(name)
                continue
            valid_values[name] = self._normalize(name, float(value))

        if missing and self.missing_feature_policy == "invalidate":
            return {**base, "reason": "Insufficient valid features"}
        if not valid_values:
            return {**base, "reason": "Insufficient valid features"}

        weights = {name: abs(float(self.feature_weights.get(name, 1.0)))
                   for name in valid_values}
        total_weight = sum(weights.values())
        if total_weight <= 0:
            return {**base, "reason": "Insufficient valid features"}
        weighted = sum(valid_values[name] * weights[name] for name in valid_values)
        normalized_score = weighted / total_weight
        score = self._map_score(normalized_score)
        confidence = sum(weights.values()) / sum(
            abs(float(self.feature_weights.get(name, 1.0))) for name in names
        )
        return {
            **base,
            "attention_score": score,
            "valid": True,
            "confidence": max(0.0, min(1.0, confidence)),
        }

    def _normalize(self, name: str, value: float) -> float:
        baseline = self.baselines.get(name)
        if baseline is not None:
            mean = float(baseline.get("mean", 0.0))
            scale = float(baseline.get("std", 1.0))
            if scale <= 0:
                raise ValueError(f"baseline std must be positive for {name}")
            value = (value - mean) / scale
        return value * float(self.feature_directions.get(name, 1.0))

    def _map_score(self, value: float) -> float:
        low = float(self.score_mapping["input_min"])
        high = float(self.score_mapping["input_max"])
        output_low = float(self.score_mapping["output_min"])
        output_high = float(self.score_mapping["output_max"])
        if high <= low or output_high < output_low:
            raise ValueError("invalid score mapping range")
        ratio = max(0.0, min(1.0, (value - low) / (high - low)))
        return max(0.0, min(100.0, output_low + ratio * (output_high - output_low)))

    def _validate_configuration(self) -> None:
        if self.missing_feature_policy not in {"invalidate", "skip"}:
            raise ValueError("missing_feature_policy must be 'invalidate' or 'skip'")
        if len(set(self.expected_features)) != len(self.expected_features):
            raise ValueError("expected_features must be unique")
        for name, weight in self.feature_weights.items():
            if not isinstance(weight, Real) or not float(weight) >= 0:
                raise ValueError(f"feature weight must be non-negative: {name}")
        for name, direction in self.feature_directions.items():
            if not isinstance(direction, Real) or float(direction) == 0:
                raise ValueError(f"feature direction must be non-zero: {name}")
