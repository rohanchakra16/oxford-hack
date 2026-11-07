# EEG buffering and preprocessing

This document describes the processing layer used between acquisition and
future dataset or real-time components. It does **not** describe attention
features or attention scores; neither is calculated here.

## Data contract

Both components consume the acquisition layer's `SampleBatch`:

- `samples`: a two-dimensional array with shape
  `(sample_count, channel_count)`.
- `timestamps`: one acquisition timestamp per row.
- `sample_indices`: one global stream index per row.
- `sampling_frequency_hz`: the rate used to configure filters.
- Channel names and signal units: preserved as batch metadata.

The processing layer preserves row and channel order. The preprocessor returns
the processed arrays and their original timestamps and indices in
`PreprocessedBatch`.

## `EEGBuffer`

`EEGBuffer(capacity_seconds, sampling_frequency_hz)` is a bounded,
thread-safe circular buffer. It is intended for an acquisition thread that
appends batches and an analysis or user-interface thread that requests a
recent time window.

When a batch is appended:

1. Samples, timestamps, and indices are appended together.
2. A forward jump in indices is recorded as an acquisition gap.
3. Rows older than the configured capacity are evicted from all three arrays.
4. The `BufferStatus` counters record observed gaps and evicted samples.

`dropped_sample_count` combines acquisition gaps and capacity evictions.
`gap_count` counts gap events only, while `overflowed` indicates that at least
one capacity eviction has occurred. Call `reset()` between unrelated streams.

## `EEGPreprocessor`

`EEGPreprocessor` applies independent, configurable operations:

1. Non-finite values are counted and replaced with zero for numerical safety.
2. Optional DC-offset tracking and removal is applied per channel.
3. An optional fourth-order Butterworth bandpass is applied. The default is
   1-40 Hz.
4. An optional notch filter can target 50 or 60 Hz mains interference.
5. Basic signal quality indicators are calculated.

The SciPy filters are causal and retain their internal state between
`process()` calls. Therefore, processing two consecutive batches produces the
same result as processing their concatenation in one call. Do not create a
new preprocessor for each overlapping analysis window; doing so would
reinitialise the filter and introduce boundary transients. Call `reset()` when
switching to a new acquisition stream.

The first batch configures the filter sampling rate and channel count. Later
batches must use the same sampling rate and channel count. A change in either
requires a new preprocessor or an explicit reset and reconfiguration.

## Quality metadata

Each processed batch reports:

- `missing_sample_count`: number of sample indices missing immediately before
  this batch.
- `non_finite_sample_count`: number of NaN or infinite input values.
- `flatline_channels`: channel indices whose peak-to-peak range is at or below
  the configured tolerance.
- `excessive_amplitude_channels`: channel indices exceeding the configured
  absolute amplitude threshold.
- `channel_flags`: per-channel booleans for those checks.

These are basic engineering indicators for monitoring data quality. They are
not a complete physiological artifact detector, clinical assessment, or
replacement for domain-specific EEG artifact-removal methods.
