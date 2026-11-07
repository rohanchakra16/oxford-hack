# EEG component guide (Unicorn EEG)

> Moved here from the repository root README by the integration branch; paths are relative to `eeg/`.
> The shared root README is the repository README.

Initial project scaffold for acquiring EEG data from a g.tec Unicorn BCI,
building labelled EEG datasets, and estimating attention in real time.

The acquisition layer provides a hardware-independent device interface, a
deterministic simulated EEG device, and an optional g.tec UnicornPy adapter.
The vendor SDK is not bundled with this project; the Unicorn adapter fails
clearly when it is unavailable. Dataset construction, preprocessing, feature
extraction, classification, and real-time streaming are implemented as
separate replaceable layers.

## Requirements

- Python 3.11 or newer
- A supported operating system for the Python dependencies in
  `requirements.txt`

## Installation

From the project directory:

```bash
python3.11 -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
python -m pip install --upgrade pip
python -m pip install -r eeg/requirements.txt  # from the repository root
```

## Execution

Run the minimal application entry point from this directory:

```bash
python -m eeg.main  # from the repository root
```

The application loads and validates `eeg/config.yaml`, then configures logging.

## Device configuration and Unicorn SDK setup

The mock device is hardware-independent and is used by the automated tests.
The physical adapter requires the official g.tec UnicornPy SDK installed in
the same virtual environment as this project. Obtain the SDK from g.tec,
follow its platform-specific installation instructions, and verify that
`python -c "import UnicornPy"` succeeds before selecting `unicorn` in the
GUI. The adapter does not fall back to simulated data when the SDK is absent.

The device reports the actual sampling frequency and channel metadata at
runtime. Do not copy the mock `acquisition.sample_rate_hz` into hardware
configuration; it is only the scaffold default.

## Tests

```bash
cd eeg && python -m pytest
```

## Project layout

- `eeg/acquisition`: device interface and simulated EEG acquisition
- `eeg/processing`: buffering, preprocessing, and signal-quality processing
- `eeg/dataset`: labelled recording models and SQLite/NPZ persistence
- `eeg/realtime`: feature extraction, classification, and real-time streaming
- `eeg/utils`: shared configuration and logging utilities
- `tests`: automated tests

## EEG buffering and preprocessing

`EEGBuffer` is a thread-safe bounded circular buffer for `SampleBatch`
objects. It preserves samples, timestamps, and sample indices together,
reports acquisition gaps, records samples evicted by capacity overflow, and
can be reset between streams.

`EEGPreprocessor` provides optional DC-offset removal, configurable
Butterworth bandpass filtering (default `1-40 Hz`), optional 50/60 Hz notch
filtering, and basic configurable quality checks. Filter state is retained
between calls, so consecutive batches form one continuous stream rather than
reinitialising a causal filter for each analysis window.

Quality metadata reports missing indices, non-finite values, flatline
channels, excessive amplitude, and per-channel flags. These checks are basic
signal-quality indicators and are not complete physiological artefact
removal.

See [docs/EEG_PREPROCESSING.md](EEG_PREPROCESSING.md) for the detailed
data contract, buffering semantics, filter-state behavior, and quality
metadata definitions.

See [docs/EEG_RECORDING_DATABASE.md](EEG_RECORDING_DATABASE.md) for the
recording schema, NPZ contents, and consistency guarantees.

See [docs/EEG_DATASET_EXPORT.md](EEG_DATASET_EXPORT.md) for raw dataset
export formats, CSV sidecars, and validated loading behavior.

See [docs/EEG_FEATURE_EXTRACTION.md](EEG_FEATURE_EXTRACTION.md) for the
pluggable feature registry, stub features, configuration, and output schema.

See [docs/EEG_ATTENTION_CLASSIFIER.md](EEG_ATTENTION_CLASSIFIER.md) for
the classifier interface, deterministic stub, and replacement guidance.

See [docs/EEG_STREAMING_PIPELINE.md](EEG_STREAMING_PIPELINE.md) for the
producer-consumer real-time processing pipeline and frame contract.

`RecordingManager` provides a GUI-independent recording lifecycle. It collects
raw device batches in a background thread, transitions to a review-pending
state when acquisition stops, and requires an explicit save or discard.
Persistence failures retain the temporary session for retry or discard.

## Dataset construction and export

Launch the dataset GUI with:

```bash
python -c "from eeg.dataset.dataset_gui import run; raise SystemExit(run())"
```

Select a device and configured label, connect, record, stop, then explicitly
save or discard. Saving writes raw samples to NPZ and metadata to SQLite;
discarding creates no database entry. Optional model-training feature frames
are written separately and never replace raw EEG.

Use `DatasetExporter` for NPZ, CSV plus JSON sidecar, or JSON metadata
exports. `DatasetLoader` validates exported files before reconstructing
samples, timestamps, indices, channels, labels, and annotations.

## Feature registration and model replacement

Register arbitrary features without changing the framework:

```python
from eeg.realtime import EEGFeatureExtractor, FeatureRegistry

def channel_spread(eeg_window, sampling_rate, channel_info, config=None):
    return float(eeg_window.max() - eeg_window.min())

registry = FeatureRegistry()
registry.register("channel_spread", channel_spread)
extractor = EEGFeatureExtractor(registry)
```

The extractor executes only registered features. Configure the enabled feature
names and per-feature settings in `eeg/config.yaml`; placeholder names are not
required. Feature failures are represented in the frame and do not stop other
features.

`StubAttentionClassifier` accepts dynamic feature names and produces a
deterministic development score. It is not trained, validated, or calibrated.
Replace it with a class implementing `AttentionClassifier.predict(features)`
when a trained model is available; the streaming controller does not need to
change.

## Preprocessing and real-time streaming

`EEGPreprocessor` provides stateful optional filtering and quality indicators.
`StreamingController` uses a producer-consumer pipeline with a two-second
window, 75% overlap, and 500 ms updates by default. It reports latency,
queue-depth, deadline, and overflow metrics through `StreamingStats` and logs
each emitted frame.

## Hardware-independent testing

Run the complete suite without Unicorn hardware:

```bash
cd eeg && QT_QPA_PLATFORM=offscreen python -m pytest -q
```

The suite covers acquisition, dataset save/reload/discard, preprocessing,
feature registration and failures, classifier behavior, GUI state transitions,
real-time streaming, raw-data integrity, thread cleanup, and lightweight
latency/memory measurements. The audit tests use Python `tracemalloc` for peak
allocation reporting; production CPU monitoring can be added with the host's
process metrics tooling.

## Architecture and object documentation

- [docs/ARCHITECTURE.md](ARCHITECTURE.md): interaction graph and runtime
  data flow.
- [docs/OBJECT_REFERENCE.md](OBJECT_REFERENCE.md): documentation for
  every implemented public object.

These documents are maintained as the implementation grows. New public
objects and subsystem interactions should be added to both references.

## EEG acquisition

`MockEEGDevice` implements the same lifecycle as a future physical device:

```python
from eeg.acquisition import MockEEGDevice

device = MockEEGDevice(seed=42)
device.connect()
device.start_streaming()
batch = device.get_samples(250)
device.disconnect()  # Stops an active stream before disconnecting.
```

Each `SampleBatch.samples` array has shape
`(sample_count, channel_count)` and contains microvolt (`uV`) values.
`timestamps` has shape `(sample_count,)` and contains seconds from the stream
clock. `sample_indices` has shape `(sample_count,)` and contains consecutive
zero-based indices. Channel names, sampling frequency, and units are included
in the batch metadata.

### g.tec Unicorn adapter

Install the official g.tec UnicornPy SDK separately according to its vendor
documentation, then construct the physical adapter with
`create_device("unicorn")`. The adapter uses the SDK's discovered device
serial, configuration, sampling-rate constant, channel metadata, and
float32 acquisition buffer without assuming a sample rate or dropping
auxiliary channels. Unicorn SDK data does not provide per-sample timestamps
through this API, so the adapter labels timestamps as host monotonic
acquisition timestamps in `get_device_info()["timestamp_source"]`.

All enabled channels are retained in SDK order. EEG and auxiliary channels
(accelerometer, gyroscope, battery, counter, and validation indicator) are
described separately in `get_device_info()["channels"]`. SDK acquisition
errors, including buffer overflow, are raised as `UnicornSDKError`; they are
not converted into empty or simulated data.

## Dataset construction GUI

Install the declared dependencies, including PySide6, in the project
environment:

```bash
python -m pip install -r eeg/requirements.txt  # from the repository root
```

Launch the GUI from the repository root:

```bash
python -c "from eeg.dataset.dataset_gui import run; raise SystemExit(run())"
```

The GUI reads recording labels from `dataset.labels` in [config.yaml](../config.yaml).
The `mock` device is available on all development systems. The `unicorn`
option requires the separately installed official g.tec UnicornPy SDK and
compatible hardware. On Linux, ensure the Qt platform libraries and display
server are available; on macOS, launch from a terminal or IDE session with
GUI permissions; on Windows, use a standard Python installation with the Qt
wheel installed.

For headless CI or development, use Qt's offscreen platform:

```bash
cd eeg && QT_QPA_PLATFORM=offscreen python -m pytest
```

Connection and persistence operations run in Qt worker threads, while
`RecordingManager` owns background sample collection. Stopping a recording
always opens an explicit Save Recording / Discard Recording decision; the GUI
never saves automatically.
