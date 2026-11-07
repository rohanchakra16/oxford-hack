import pytest

from eeg.realtime.attention_classifier import StubAttentionClassifier


def frame(**values):
    return {
        "timestamp": 12.5,
        "frame_index": 3,
        "features": {
            name: {"value": value, "valid": True} for name, value in values.items()
        },
    }


def test_stub_is_deterministic_and_preserves_frame_metadata() -> None:
    classifier = StubAttentionClassifier(expected_features=("custom_a", "custom_b"))
    first = classifier.predict(frame(custom_a=0.25, custom_b=0.75))
    second = classifier.predict(frame(custom_a=0.25, custom_b=0.75))
    assert first == second
    assert first["attention_score"] == 50.0
    assert first["valid"] is True
    assert first["timestamp"] == 12.5
    assert first["frame_index"] == 3


def test_score_boundaries_and_dynamic_names() -> None:
    classifier = StubAttentionClassifier(expected_features=("user_feature",))
    assert classifier.predict(frame(user_feature=-1))["attention_score"] == 0.0
    assert classifier.predict(frame(user_feature=2))["attention_score"] == 100.0


def test_weights_directions_and_baseline() -> None:
    classifier = StubAttentionClassifier(
        expected_features=("up", "down"),
        feature_weights={"up": 3, "down": 1},
        feature_directions={"down": -1},
        baselines={"up": {"mean": 0.0, "std": 1.0}},
    )
    result = classifier.predict(frame(up=1.0, down=-1.0))
    assert result["attention_score"] == 100.0


def test_missing_features_and_invalid_input() -> None:
    classifier = StubAttentionClassifier(expected_features=("a", "b"))
    result = classifier.predict(frame(a=0.5))
    assert result["valid"] is False
    assert result["reason"] == "Insufficient valid features"
    assert classifier.predict({"features": []})["reason"] == "Invalid feature input"


def test_skip_policy_and_invalid_value() -> None:
    classifier = StubAttentionClassifier(
        expected_features=("a", "b"), missing_feature_policy="skip"
    )
    result = classifier.predict(frame(a=0.5, b="not numeric"))
    assert result["valid"] is True
    assert result["attention_score"] == 50.0


def test_configuration_validation() -> None:
    with pytest.raises(ValueError):
        StubAttentionClassifier(missing_feature_policy="unknown")
    with pytest.raises(ValueError):
        StubAttentionClassifier(feature_weights={"x": -1})
