"""Real-time EEG attention components."""

from .feature_extractor import EEGFeatureExtractor
from .feature_registry import FeatureRegistry, FeatureRegistryError
from .feature_types import FeatureFunction, FeatureResult, RegisteredFeature

__all__ = [
    "EEGFeatureExtractor",
    "FeatureFunction",
    "FeatureRegistry",
    "FeatureRegistryError",
    "FeatureResult",
    "RegisteredFeature",
]
