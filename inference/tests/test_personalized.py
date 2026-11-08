from dataclasses import replace

import pytest

from inference.calibration import CalibrationMemory, calibration_statistics
from inference.model_source import (
    ModelPipeline,
    RegistryModelExtractor,
    UnavailableModelSource,
    make_model_source,
)
from inference.personalized import PersonalizedAttention
from inference.tests.test_live_attention import adapter, feed, window


def personal(tmp_path):
    base = adapter()
    result = PersonalizedAttention(base.context, CalibrationMemory(tmp_path))
    result.config = replace(result.config, boundary_margin_ms=0)
    result.on_eligibility(base._eligibility)
    result.on_sensor_status(base._sensors)
    return result


def test_calibration_requires_task_saves_and_reuses_compatible_model(tmp_path):
    result = personal(tmp_path)
    assert feed(result, 2000, 25000, 80) == []
    assert result.profile is None
    result.calibration_action("start", "Alice")
    feed(result, 25500, 45500, 80)
    assert result.profile["mean"] == 80
    assert result.snapshot()["profile"]["std"] == 0
    restored = personal(tmp_path)
    restored.calibration_action("load", "Alice")
    feed(restored, 2000, 2000, 80)
    assert restored.profile == result.profile
    saved = restored.profile
    restored.calibration_action("start", "Alice")
    feed(restored, 2500, 5000, 80)
    restored.calibration_action("cancel", "Alice")
    assert restored.profile == saved
    changed = window(5500, 80).model_copy(update={"channels": ["different"]})
    restored.score_features(changed)
    assert restored.profile is None  # geometry change cannot reuse Alice's old baseline


def test_invalid_and_unstable_calibration_never_overwrites_valid_memory(tmp_path):
    memory = CalibrationMemory(tmp_path)
    valid = calibration_statistics([80.0] * 40)
    memory.save("Alice", ["model-v1"], valid)
    with pytest.raises(ValueError):
        calibration_statistics([0.0, 100.0] * 20)
    assert memory.load("Alice", ["model-v1"]) == valid
    assert memory.load("Bob", ["model-v1"]) is None
    assert memory.load("Alice", ["model-v2"]) is None
    memory.reset("Alice", ["model-v1"])
    assert memory.load("Alice", ["model-v1"]) is None


def test_default_memory_survives_changing_launch_directory(tmp_path, monkeypatch):
    monkeypatch.delenv("REMIND_CALIBRATION_DIR", raising=False)
    original = CalibrationMemory().root
    monkeypatch.chdir(tmp_path)
    assert CalibrationMemory().root == original
    assert original.is_absolute()


def test_new_lecture_restores_profile_but_changed_window_requires_calibration(tmp_path):
    first = personal(tmp_path)
    first.calibration_action("start", "Alice")
    feed(first, 2000, 22000, 80)
    second = personal(tmp_path)
    second.calibration_action("load", "Alice")
    assert second.profile is None  # wait for current model/device signature
    feed(second, 2000, 2000, 80)
    assert second.profile == first.profile
    assert not second.collecting
    changed = window(2500, 80)
    changed = changed.model_copy(
        update={"samples": changed.samples.model_copy(update={"expected": 1000})}
    )
    second.score_features(changed)
    assert second.profile is None


def test_expired_or_future_profiles_require_recalibration(tmp_path):
    import time

    memory = CalibrationMemory(tmp_path)
    for created in [time.time() - 91 * 86400, time.time() + 86400, float("nan")]:
        profile = {**calibration_statistics([80.0] * 40), "created": created}
        memory.save("Alice", ["v1"], profile)
        assert memory.load("Alice", ["v1"]) is None


def test_hysteresis_keeps_eight_second_episode_across_medium_noise():
    result = adapter(smoothing_ms=0)
    assert feed(result, 2000, 5500, 5) == []
    assert feed(result, 6000, 9500, 35) == []  # between enter and recover thresholds
    assert len(feed(result, 10000, 10000, 5)) == 1
    assert feed(result, 10500, 12000, 90) == []  # brief recovery doesn't rearm
    assert feed(result, 12500, 45000, 5) == []
    feed(result, 45500, 50000, 90)
    assert len(feed(result, 50500, 60000, 5)) == 1


def test_personalized_trigger_and_bad_quality_suppression(tmp_path):
    result = personal(tmp_path)
    result.calibration_action("start")
    feed(result, 2000, 22000, 80)
    assert len(feed(result, 22500, 45000, 5)) == 1
    assert feed(result, 45500, 80000, 5) == []
    poor = window(80500, 0)
    poor = poor.model_copy(
        update={"quality": poor.quality.model_copy(update={"usable": False})}
    )
    result.on_eeg_window(poor)
    assert result.poll(80650) == []
    assert result.snapshot()["score"] is None


def test_registry_model_consumes_actual_values_and_rejects_stub():
    np = pytest.importorskip("numpy")
    from eeg.realtime.feature_registry import FeatureRegistry
    from eeg.realtime.attention_classifier import StubAttentionClassifier

    registry = FeatureRegistry()
    registry.register("provided_feature", lambda samples, rate, info, config: 0.8)

    class ImplementedTestClassifier:
        def predict(self, frame):
            return {
                "attention_score": frame["features"]["provided_feature"]["value"],
                "valid": True,
                "confidence": 0.9,
                "model_type": "test_only",
            }

    pipeline = ModelPipeline(
        registry, ImplementedTestClassifier(), "controlled-test", "1", 0, 1, True
    )
    extractor = RegistryModelExtractor(pipeline)
    result = extractor.extract(np.ones((500, 2)), 250, {})
    assert result["features"]["attention_score"]["value"] == 80
    assert result["features"]["raw_model_output"]["value"] == 0.8
    assert result["features"]["registry.provided_feature"]["value"] == 0.8
    pipeline.classifier = StubAttentionClassifier()
    with pytest.raises(ValueError, match="stub rejected"):
        RegistryModelExtractor(pipeline)


def test_no_model_factory_never_uses_spectral_fallback(monkeypatch):
    monkeypatch.delenv("REMIND_MODEL_FACTORY", raising=False)
    assert isinstance(make_model_source(), UnavailableModelSource)


def test_personalized_combination_needs_model_and_gaze_corroboration(tmp_path):
    from inference.tests.test_live_combined import (
        adapter as combined_adapter,
        feed as combined_feed,
    )
    from oxford_hack.contracts.payloads import ReviewCandidate

    original, calibration = combined_adapter()
    result = PersonalizedAttention(original.context, CalibrationMemory(tmp_path))
    result.config = replace(result.config, boundary_margin_ms=0)
    result.on_eligibility(original._eligibility)
    result.on_sensor_status(original._sensors)
    result.on_gaze_calibration(calibration)
    result.calibration_action("start")
    combined_feed(result, 2000, 22000, score=80, outside=False)
    assert result.profile is not None
    assert combined_feed(result, 22500, 35000, score=5, outside=False) == []
    events = combined_feed(result, 35500, 60000, score=5, outside=True)
    assert len(events) == 1
    event = ReviewCandidate.model_validate(events[0].model_dump(by_alias=False))
    assert event.mode == "both"
    assert any(
        score.name == "personal_smoothed_model_score" and score.scale == "score_0_100"
        for signal in event.contributing_signals
        for score in signal.scores
    )
