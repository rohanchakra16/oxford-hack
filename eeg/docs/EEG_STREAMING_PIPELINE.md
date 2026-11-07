# Real-time EEG streaming pipeline

`StreamingController` connects the device, preprocessing, feature registry, and
attention classifier without embedding any EEG biomarker calculations.

## Pipeline

```text
EEGDevice
  -> bounded acquisition queue
  -> EEGPreprocessor (continuous state)
  -> EEGBuffer (timestamp/index aligned)
  -> sliding analysis window
  -> EEGFeatureExtractor
  -> AttentionClassifier
  -> output frame / callback
```

The default window is 2 seconds and the default update interval is 500 ms
(2 Hz), which gives 75% overlap. Window and update sample counts are calculated
from the sampling frequency reported by the device; no fixed hardware rate is
assumed. Overlap is analysis-window reuse, not duplicated acquisition: each
device batch enters the producer queue exactly once, while a sample may
naturally occur in several overlapping windows.

Acquisition and processing use separate daemon threads. The acquisition queue
is bounded. If it fills, the controller records an explicit error and stops
instead of silently dropping samples. The output queue is also bounded; its
overflow is reported through `StreamingStats.missed_update_deadlines` and a
warning log. Applications needing every frame should consume the queue
promptly or use `on_frame`.

Every frame contains frame index, window timestamps, source sample-index
bounds, preprocessed metadata and quality indicators, feature values and
execution times, attention score, prediction validity, and model type. Invalid
features or predictions still produce a frame.

`StreamingStats` reports acquisition, preprocessing, feature, classification,
and total processing latency, queue depth, missed output deadlines, and buffer
overflow state. `stop()` stops the device and joins both worker threads.
