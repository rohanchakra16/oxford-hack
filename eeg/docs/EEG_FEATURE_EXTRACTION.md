# Pluggable EEG feature extraction

The real-time feature framework defines registration and execution contracts
only. It intentionally does **not** implement EEG biomarkers or attention
calculations.

## Registering a feature

Feature functions receive a two-dimensional preprocessed window, sampling
frequency, channel metadata, and optional configuration:

```python
def window_mean(eeg_window, sampling_rate, channel_info, config=None):
    return float(eeg_window.mean())

registry.register("window_mean", window_mean)
```

Functions may return scalars, vectors, mappings, or any other structured
value. For an explicitly unavailable result, return:

```python
FeatureResult(None, valid=False, error="Not available for this device")
```

Returning `None` without `FeatureResult` is treated as an invalid feature
execution. Exceptions are captured per feature, so another feature still runs.

## Configuration and selection

`eeg/config.yaml` contains `features.enabled` and `features.settings`. The
application can select only the enabled names when populating a registry; the
extractor executes exactly the features registered in that registry. Settings
are passed to the corresponding function and are not interpreted by the
framework.

The six names in `stub_features.py` are placeholders. They all return an
explicitly invalid `Not implemented` result and contain no mathematical
biomarker implementation. Users can remove a stub and register a custom
function under the same name.

## Output

Each call returns a frame with `timestamp`, per-feature `value`/`valid`/`error`
fields, `execution_times_ms`, and `overall_valid`. No attention score or
feature-specific assumption is added to this schema.
