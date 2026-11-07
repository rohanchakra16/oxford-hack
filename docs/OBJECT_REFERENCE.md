# EEG project object reference

This page documents the objects currently implemented in the project. It is
the maintained object-level reference for future implementation work: every
new public class, function, or data model should be added here when it is
introduced.

## Acquisition

### `SampleBatch`

Defined in `eeg/acquisition/base_device.py`.

Immutable transport object for one ordered group of acquired samples.

- `samples`: shape `(sample_count, channel_count)`.
- `timestamps`: one acquisition timestamp per sample.
- `sample_indices`: global stream indices for each sample.
- `channel_names`: ordered channel labels.
- `sampling_frequency_hz`: sampling rate used by the device.
- `signal_units`: units for the samples.

`SampleBatch` validates that all per-sample arrays have matching lengths and
that channel metadata matches the sample columns.

### `EEGDevice`

Defined in `eeg/acquisition/base_device.py`.

Abstract lifecycle interface implemented by physical and development devices:
`connect`, `disconnect`, `start_streaming`, `get_samples`,
`stop_streaming`, and `get_device_info`.

### `DeviceStateError`

Defined in `eeg/acquisition/base_device.py`.

Raised when a device method is called in an invalid lifecycle state, such as
requesting samples before streaming starts.

### `MockEEGDevice`

Defined in `eeg/acquisition/mock_device.py`.

Hardware-independent device implementation that generates deterministic or
seeded multichannel oscillatory signals with noise. It is intended for tests,
UI development, and development without a Unicorn headset.

### `UnicornEEGDevice`

Defined in `eeg/acquisition/unicorn_device.py`.

Optional g.tec UnicornPy adapter. The SDK is loaded lazily, so importing the
project does not require the vendor SDK. It preserves the SDK's channel order,
sampling rate, units, and acquisition errors. Timestamps are explicitly
identified as host monotonic timestamps because the supported SDK API does not
provide per-sample timestamps.

### `UnicornSDKError`

Defined in `eeg/acquisition/unicorn_device.py`.

Wraps SDK availability, connection, acquisition, and shutdown failures without
falling back to simulated data.

### `create_device`

Defined in `eeg/acquisition/factory.py`.

Device factory. `create_device("mock", ...)` returns `MockEEGDevice`;
`create_device("unicorn", ...)` returns `UnicornEEGDevice`. Unknown device
types raise `ValueError`.

## Processing

### `EEGBuffer`

Defined in `eeg/processing/eeg_buffer.py`.

Thread-safe, bounded circular buffer for `SampleBatch` objects. It keeps
samples, timestamps, and indices aligned while retaining only its configured
capacity.

It reports:

- observed forward gaps in sample indices;
- samples missing from those gaps;
- samples evicted due to capacity overflow;
- whether overflow has occurred.

### `BufferStatus`

Defined in `eeg/processing/eeg_buffer.py`.

Immutable snapshot of buffer size, dropped sample count, gap count, overflow
state, and latest sample index.

### `EEGPreprocessor`

Defined in `eeg/processing/signal_preprocessor.py`.

Stateful signal-processing pipeline. It can independently perform:

- DC-offset removal;
- a configurable Butterworth bandpass, defaulting to 1-40 Hz;
- an optional 50/60 Hz notch filter;
- basic input-quality checks.

SciPy filter state is retained between calls. It does not calculate features,
attention scores, or complete physiological artifact removal.

### `PreprocessedBatch`

Defined in `eeg/processing/signal_preprocessor.py`.

Immutable-shaped result object containing processed samples, unchanged
timestamps and sample indices, and quality metadata.

## Dataset

### `RecordingMetadata`

Defined in `eeg/dataset/recording_metadata.py`.

Validated metadata row for one recording. It contains the UUID, label,
timestamps, duration, sampling rate, channel metadata, device identity, raw
NPZ path, sample count, and creation time.

### `RecordingAnnotation`

Defined in `eeg/dataset/recording_metadata.py`.

Validated label interval associated with a recording. Its `start_sample` and
`end_sample` values refer to global sample indices, not array offsets.

### `Recording`

Defined in `eeg/dataset/recording_metadata.py`.

Aggregate returned by the database containing `RecordingMetadata`, the raw
`SampleBatch`, and any annotations.

### `RecordingDatabase`

Defined in `eeg/dataset/recording_database.py`.

SQLite/NPZ persistence service. It stores metadata and annotations in SQLite
and raw EEG arrays in compressed NPZ files. It provides recording creation,
retrieval, listing, label filtering, update, deletion, and annotation
insertion.

Raw arrays are never replaced with preprocessed arrays. NPZ creation is
atomic, and database insertion failures remove the temporary data file.

## Utilities

### `ConfigurationError`

Defined in `eeg/utils/configuration.py`.

Raised when the YAML configuration is missing required sections or contains
invalid values.

### `load_config` and `validate_config`

Defined in `eeg/utils/configuration.py`.

`load_config` reads YAML from disk and delegates schema validation to
`validate_config`. The result is a validated dictionary used by the
application entry point and logging setup.

### `configure_logging`

Defined in `eeg/utils/logging_config.py`.

Configures the root Python logger from the validated `logging.level`
configuration value.

### `utc_now_iso`

Defined in `eeg/dataset/recording_metadata.py`.

Returns a timezone-aware UTC ISO-8601 timestamp for recording metadata.

## Application entry point

### `main`

Defined in `main.py`.

Loads the root `config.yaml` and initializes application logging. Hardware
acquisition and processing are invoked by future application layers rather
than by this minimal bootstrap.
