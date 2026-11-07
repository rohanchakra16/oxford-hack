"""Registration and validation of user-provided EEG feature functions."""

from __future__ import annotations

import inspect
from collections.abc import Iterable, Mapping
from typing import Any

from .feature_types import FeatureFunction, RegisteredFeature


class FeatureRegistryError(ValueError):
    """Raised when a feature registration is invalid."""


class FeatureRegistry:
    """Store uniquely named feature functions in registration order."""

    def __init__(self) -> None:
        self._features: dict[str, RegisteredFeature] = {}

    def register(
        self,
        name: str,
        function: FeatureFunction,
        *,
        config: Mapping[str, Any] | None = None,
    ) -> None:
        """Register one callable feature, rejecting duplicate names."""
        if not isinstance(name, str) or not name.strip():
            raise FeatureRegistryError("feature name must be a non-empty string")
        normalized_name = name.strip()
        if normalized_name in self._features:
            raise FeatureRegistryError(f"feature already registered: {normalized_name}")
        self._validate_signature(function)
        self._features[normalized_name] = RegisteredFeature(
            normalized_name, function, config
        )

    def register_many(
        self,
        features: Iterable[tuple[str, FeatureFunction]],
        *,
        settings: Mapping[str, Mapping[str, Any]] | None = None,
    ) -> None:
        """Register several ``(name, function)`` pairs."""
        for name, function in features:
            self.register(name, function, config=(settings or {}).get(name))

    def remove(self, name: str) -> None:
        """Remove a feature, raising when it is not registered."""
        if name not in self._features:
            raise FeatureRegistryError(f"feature is not registered: {name}")
        del self._features[name]

    def list_features(self) -> tuple[str, ...]:
        """Return registered names in registration order."""
        return tuple(self._features)

    def get(self, name: str) -> RegisteredFeature:
        """Return a registered feature by name."""
        try:
            return self._features[name]
        except KeyError as error:
            raise FeatureRegistryError(f"feature is not registered: {name}") from error

    @staticmethod
    def _validate_signature(function: FeatureFunction) -> None:
        if not callable(function):
            raise FeatureRegistryError("feature function must be callable")
        try:
            signature = inspect.signature(function)
            sentinel = object()
            try:
                signature.bind(sentinel, 1.0, {}, None)
            except TypeError:
                signature.bind(sentinel, 1.0, {})
        except (TypeError, ValueError) as error:
            raise FeatureRegistryError(
                "feature function must accept eeg_window, sampling_rate, "
                "channel_info, and optional config"
            ) from error
