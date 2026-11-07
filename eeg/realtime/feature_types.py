"""Types shared by the pluggable EEG feature extraction framework."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Optional

import numpy as np


# Assignment-based aliases keep this module importable on Python 3.9, where
# ``typing.TypeAlias`` is not available. The postponed annotations below still
# provide the declared types to modern type checkers.
FeatureFunction = Callable[
    [np.ndarray, float, Mapping[str, Any], Optional[Mapping[str, Any]]], Any
]
FeatureValue = Any


@dataclass(frozen=True)
class FeatureResult:
    """Validated result for one feature.

    ``value`` may be a scalar, vector, mapping, or another serializable
    structure. ``valid=False`` is used when a feature is unavailable.
    """

    value: FeatureValue
    valid: bool = True
    error: str | None = None

    def __post_init__(self) -> None:
        if self.valid and self.error is not None:
            raise ValueError("valid feature results must not contain an error")
        if not self.valid and not self.error:
            raise ValueError("invalid feature results must contain an error")


@dataclass(frozen=True)
class RegisteredFeature:
    """A named feature function and its optional configuration."""

    name: str
    function: FeatureFunction
    config: Mapping[str, Any] | None = None
