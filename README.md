# Unicorn EEG Attention

Initial project scaffold for acquiring EEG data from a g.tec Unicorn BCI,
building labelled EEG datasets, and estimating attention in real time.

The acquisition layer provides a hardware-independent device interface, a
deterministic simulated EEG device, and an optional g.tec UnicornPy adapter.
The vendor SDK is not bundled with this project; the Unicorn adapter fails
clearly when it is unavailable. EEG processing, dataset construction, and
attention estimation are intentionally not implemented yet.

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
python -m pip install -r requirements.txt
```

## Execution

Run the minimal application entry point from this directory:

```bash
python main.py
```

The application loads and validates `config.yaml`, then configures logging.

## Tests

```bash
pytest
```

## Project layout

- `eeg/acquisition`: device interface and simulated EEG acquisition
- `eeg/processing`: future EEG signal processing code
- `eeg/dataset`: labelled recording models and SQLite/NPZ persistence
- `eeg/realtime`: future real-time attention estimation code
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

See [docs/EEG_PREPROCESSING.md](docs/EEG_PREPROCESSING.md) for the detailed
data contract, buffering semantics, filter-state behavior, and quality
metadata definitions.

See [docs/EEG_RECORDING_DATABASE.md](docs/EEG_RECORDING_DATABASE.md) for the
recording schema, NPZ contents, and consistency guarantees.

See [docs/EEG_DATASET_EXPORT.md](docs/EEG_DATASET_EXPORT.md) for raw dataset
export formats, CSV sidecars, and validated loading behavior.

`RecordingManager` provides a GUI-independent recording lifecycle. It collects
raw device batches in a background thread, transitions to a review-pending
state when acquisition stops, and requires an explicit save or discard.
Persistence failures retain the temporary session for retry or discard.

## Architecture and object documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): interaction graph and runtime
  data flow.
- [docs/OBJECT_REFERENCE.md](docs/OBJECT_REFERENCE.md): documentation for
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
python -m pip install -r requirements.txt
```

Launch the GUI from the repository root:

```bash
python -c "from eeg.dataset.dataset_gui import run; raise SystemExit(run())"
```

The GUI reads recording labels from `dataset.labels` in [config.yaml](config.yaml).
The `mock` device is available on all development systems. The `unicorn`
option requires the separately installed official g.tec UnicornPy SDK and
compatible hardware. On Linux, ensure the Qt platform libraries and display
server are available; on macOS, launch from a terminal or IDE session with
GUI permissions; on Windows, use a standard Python installation with the Qt
wheel installed.

For headless CI or development, use Qt's offscreen platform:

```bash
QT_QPA_PLATFORM=offscreen python -m pytest
```

Connection and persistence operations run in Qt worker threads, while
`RecordingManager` owns background sample collection. Stopping a recording
always opens an explicit Save Recording / Discard Recording decision; the GUI
never saves automatically.
