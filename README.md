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
- `eeg/dataset`: future labelled dataset construction code
- `eeg/realtime`: future real-time attention estimation code
- `eeg/utils`: shared configuration and logging utilities
- `tests`: automated tests

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
