"""Real-time EEG attention components."""

from .feature_extractor import EEGFeatureExtractor
from .feature_registry import FeatureRegistry, FeatureRegistryError
from .feature_types import FeatureFunction, FeatureResult, RegisteredFeature
from .attention_classifier import AttentionClassifier, StubAttentionClassifier
from .streaming_controller import StreamingController, StreamingStats

__all__ = [
    "EEGFeatureExtractor",
    "FeatureFunction",
    "FeatureRegistry",
    "FeatureRegistryError",
    "FeatureResult",
    "RegisteredFeature",
    "AttentionClassifier",
    "StubAttentionClassifier",
    "StreamingController",
    "StreamingStats",
]
