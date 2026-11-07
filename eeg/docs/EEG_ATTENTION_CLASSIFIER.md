# Attention classifier interface

`AttentionClassifier` consumes the structured output of
`EEGFeatureExtractor`; it does not calculate EEG features. The interface is
deliberately small so a trained scikit-learn implementation can replace the
stub without changing the streaming controller:

```python
classifier = StubAttentionClassifier(expected_features=("custom_feature_a",))
prediction = classifier.predict(feature_frame)
```

`StubAttentionClassifier` is an experimental deterministic score mapper, not a
trained, validated, or calibrated attention model. It is not a probability.
It can be configured with expected feature names, non-negative weights,
directions, per-feature baseline mean/std values, a missing-feature policy
(`invalidate` or `skip`), and input/output score ranges.

## Configuration meanings

- **Feature directions** describe whether a larger feature value should
  increase or decrease the score. A direction of `1` keeps the contribution
  positive; `-1` reverses it. For example, a feature that decreases as the
  user's target state increases could use `-1`. This is a modeling
  convention, not a claim about any particular EEG biomarker.
- **Baseline mean/std normalization** compares a value with a reference
  distribution, usually measured during a separate baseline recording. The
  normalized value is `(value - mean) / std`. The mean represents the
  baseline center and `std` represents its spread. The configured standard
  deviation must be positive. The stub does not estimate these values.

The prediction includes `attention_score`, `valid`, `model_type`, `confidence`,
`timestamp`, and `frame_index`. Invalid frames return a `None` score and an
explicit reason. Feature names are entirely dynamic; no placeholder EEG
biomarker names are required.

## Meaning of `valid` and `reason`

`valid` describes whether the classifier produced a usable score for that
frame. It does not mean that the score is clinically valid, scientifically
validated, or a calibrated probability.

When `valid` is `true`, `attention_score` contains a deterministic score. When
`valid` is `false`, `attention_score` is `None` and `reason` explains why the
score was not produced. Examples include:

- `"Insufficient valid features"`: one or more expected features were missing,
  marked invalid by the extractor, or contained a non-numeric value.
- `"Invalid feature input"`: the supplied object did not contain a feature
  mapping.

With `missing_feature_policy="skip"`, valid available features can be scored
even when other expected features are unavailable. With the default
`"invalidate"` policy, missing expected features make the frame invalid.

## Sample outputs

Valid frame:

```python
{
    "attention_score": 72.5,
    "valid": True,
    "model_type": "stub",
    "confidence": 1.0,
    "timestamp": 12.5,
    "frame_index": 42,
}
```

Invalid frame because an expected feature was unavailable:

```python
{
    "attention_score": None,
    "valid": False,
    "model_type": "stub",
    "confidence": 0.0,
    "timestamp": 12.5,
    "frame_index": 42,
    "reason": "Insufficient valid features",
}
```

To replace the stub, implement:

```python
class TrainedClassifier(AttentionClassifier):
    def predict(self, features):
        values = features["features"]
        # Convert values using the model's training-time feature order.
        # Return the same documented prediction keys.
        ...
```

The replacement should preserve the same invalid-input behavior and output
schema. Model loading and calibration remain application-specific.
