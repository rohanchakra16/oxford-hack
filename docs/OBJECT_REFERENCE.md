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
Optional feature frames are stored separately as JSON and can be loaded with
`load_feature_frames`.

### `RecordingManager`

Defined in `eeg/dataset/recording_manager.py`.

GUI-independent lifecycle service that starts device streaming, collects raw
`SampleBatch` objects on a background thread, and requires an explicit save or
discard decision after stopping. `save_recording` delegates persistence to
`RecordingDatabase`; a save failure leaves the temporary review session
available for retry or discard.
When supplied with an `EEGFeatureExtractor`, it extracts one training frame
from the saved window and persists it separately from the raw NPZ. A supplied
`EEGPreprocessor` is used for the feature input only.

### `RecordingState` and `RecordingStatus`

Defined in `eeg/dataset/recording_manager.py`.

`RecordingState` represents `idle`, `recording`, or `review_pending`.
`RecordingStatus` is an immutable snapshot suitable for GUI display and
includes the label, collected sample count, save error, and saved UUID.

### `RecordingManagerError`

Defined in `eeg/dataset/recording_manager.py`.

Raised for invalid lifecycle transitions, empty recordings, inconsistent
batch metadata, acquisition failures, and interrupted persistence.

### `DatasetExporter`

Defined in `eeg/dataset/dataset_exporter.py`.

Exports raw recordings as lossless NPZ files, sample-oriented CSV files with
JSON sidecars, or metadata/annotation JSON files. It supports individual,
all-recording, label-filtered, and selected-ID exports without calculating
features.

### `DatasetLoader`

Defined in `eeg/dataset/dataset_loader.py`.

Reconstructs `Recording` objects from NPZ exports or CSV/JSON pairs. It
validates required fields, sample dimensions, channel order, sample counts,
metadata, and annotations, raising `DatasetLoadError` for missing or
corrupted data.

## Real-time features

### `FeatureRegistry`

Defined in `eeg/realtime/feature_registry.py`.

Maintains uniquely named feature functions in registration order. Features can
be registered, registered in batches with per-feature settings, retrieved,
listed, and removed. Signatures are validated before registration.

### `EEGFeatureExtractor`

Defined in `eeg/realtime/feature_extractor.py`.

Executes the currently registered functions for a preprocessed EEG window and
returns a structured frame containing values, validity, errors, timestamps,
and per-feature execution times. A failing feature is isolated from the
others. It performs no biomarker calculations.

### `FeatureResult` and `RegisteredFeature`

Defined in `eeg/realtime/feature_types.py`.

Typed models for explicit feature validity and registered function metadata.
Feature values may be scalar, vector, mapping, or another structured value.

### Stub feature functions

Defined in `eeg/realtime/stub_features.py`.

`STUB_FEATURES` contains the six requested placeholder names. Each returns an
explicit `Not implemented` invalid result and can be replaced by registering a
user implementation.

### `AttentionClassifier` and `StubAttentionClassifier`

Defined in `eeg/realtime/attention_classifier.py`.

The classifier interface consumes feature-extraction frames and returns a
structured prediction. The stub applies configurable weighting, directions,
baseline normalization, missing-feature policy, and score mapping to produce a
deterministic development score. It is not trained, validated, or calibrated,
and does not calculate EEG features.

### `StreamingController` and `StreamingStats`

Defined in `eeg/realtime/streaming_controller.py`.

`StreamingController` runs device acquisition, stateful preprocessing,
timestamp/index-preserving sliding windows, feature extraction, and
classification in producer-consumer stages. It emits complete frames even
when features or predictions are invalid. `StreamingStats` exposes latency,
queue, deadline, and overflow metrics.

## Dataset GUI

### `DatasetController`

Defined in `eeg/dataset/dataset_gui.py`.

Qt `QObject` controller that adapts device selection, connection state,
recording-manager actions, and saved-recording refreshes to signals. Device
connection, disconnection, and persistence operations run in Qt worker
threads; acquisition collection remains owned by `RecordingManager`.

### `DatasetWindow`

Defined in `eeg/dataset/dataset_gui.py`.

PySide6 main window exposing device selection, connection status, configured
labels, recording controls, duration, review decisions, and saved recording
list. It does not implement recording or persistence logic itself.

### `SaveDiscardDialog`

Defined in `eeg/dataset/dataset_gui.py`.

Modal dialog with explicit Save Recording and Discard Recording actions. There
is no automatic save path after stopping.

### `OperationWorker`

Defined in `eeg/dataset/dataset_gui.py`.

Small Qt worker object used with `QThread` to keep connection and persistence
operations out of the GUI event loop.

### `labels_from_config` and `run`

Defined in `eeg/dataset/dataset_gui.py`.

`labels_from_config` reads `dataset.labels` from YAML. `run` creates the
application, database, controller, and window for desktop execution.

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
