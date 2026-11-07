import numpy as np
import pytest

from eeg.realtime.feature_extractor import EEGFeatureExtractor
from eeg.realtime.feature_registry import FeatureRegistry, FeatureRegistryError
from eeg.realtime.feature_types import FeatureResult
from eeg.realtime.stub_features import STUB_FEATURES


def test_registry_registration_duplicate_and_removal() -> None:
    registry = FeatureRegistry()

    def custom(window, sampling_rate, channel_info, config=None):
        return float(window.mean())

    registry.register("mean", custom)
    assert registry.list_features() == ("mean",)
    assert registry.get("mean").function is custom
    with pytest.raises(FeatureRegistryError):
        registry.register("mean", custom)
    registry.remove("mean")
    assert registry.list_features() == ()


def test_custom_features_and_execution_times() -> None:
    registry = FeatureRegistry()
    registry.register("scalar", lambda window, rate, info, config=None: 2.5)
    registry.register("vector", lambda window, rate, info, config=None: [1, 2])
    output = EEGFeatureExtractor(registry).extract(
        np.ones((4, 2)), 100, {"names": ("C3", "C4")}, timestamp=3.0
    )
    assert output["timestamp"] == 3.0
    assert output["features"]["scalar"]["value"] == 2.5
    assert output["features"]["vector"]["value"] == [1, 2]
    assert output["overall_valid"] is True
    assert set(output["execution_times_ms"]) == {"scalar", "vector"}


def test_feature_exception_does_not_stop_other_features() -> None:
    registry = FeatureRegistry()
    registry.register("bad", lambda *args: (_ for _ in ()).throw(RuntimeError("boom")))
    registry.register("good", lambda *args: FeatureResult({"ok": True}))
    output = EEGFeatureExtractor(registry).extract(np.ones((2, 1)), 10, {})
    assert output["features"]["bad"]["valid"] is False
    assert output["features"]["bad"]["error"] == "boom"
    assert output["features"]["good"]["valid"] is True
    assert output["overall_valid"] is False


def test_invalid_none_result_is_reported() -> None:
    registry = FeatureRegistry()
    registry.register("none", lambda *args: None)
    output = EEGFeatureExtractor(registry).extract(np.ones((2, 1)), 10, {})
    assert output["features"]["none"]["valid"] is False


def test_stub_features_are_explicitly_unavailable() -> None:
    registry = FeatureRegistry()
    registry.register_many(STUB_FEATURES.items())
    output = EEGFeatureExtractor(registry).extract(np.ones((2, 2)), 100, {})
    assert set(output["features"]) == set(STUB_FEATURES)
    assert all(not result["valid"] for result in output["features"].values())
    assert output["overall_valid"] is False


def test_invalid_feature_signature_is_rejected() -> None:
    registry = FeatureRegistry()
    with pytest.raises(FeatureRegistryError):
        registry.register("invalid", lambda window: 1)
