"""Read-only bridge to Annie's existing SampleBatch and EEGPreprocessor APIs.

No filters are reimplemented here. Supply a checkout/snapshot of the pinned EEG
source until its owner merges it into main. This module does not modify eeg/.
"""

import hashlib
import importlib
import sys
from pathlib import Path

ANNIE_REVISION = "f20ee35c06b89ec6499bd45d79a8b67296fbabbc"
ANNIE_HASHES = {
    "eeg/acquisition/base_device.py": "c717bb6ad3f1503486aa979e1641641333da83c07c40abac940747de89dfbbb4",
    "eeg/processing/signal_preprocessor.py": (
        "d89af9393d6f06a26956cf4c48e6cfcdc54bf964ddda530dda4853428f72a9c1"
    ),
}


def load_annie_api(source_root: Path):
    root = source_root.resolve()
    for name, expected in ANNIE_HASHES.items():
        # Text hashing tolerates Git's Windows CRLF conversion.
        content = (root / name).read_text(encoding="utf-8").replace("\r\n", "\n").encode("utf-8")
        if hashlib.sha256(content).hexdigest() != expected:
            raise ValueError(f"EEG source differs from pinned {ANNIE_REVISION}: {name}")
    sys.path.insert(0, str(root))
    try:
        acquisition = importlib.import_module("eeg.acquisition.base_device")
        processing = importlib.import_module("eeg.processing.signal_preprocessor")
    finally:
        sys.path.remove(str(root))
    if Path(processing.__file__).resolve() != root / "eeg/processing/signal_preprocessor.py":
        raise ValueError("another EEG package was already loaded; use a fresh Python process")
    return acquisition.SampleBatch, processing.EEGPreprocessor


def preprocess_recording(samples, *, source_root: Path, channel_names, sampling_rate=250.0):
    """Preprocess one independent recording in continuous one-second batches.

    Return processed samples and a per-sample usability mask. Filter state is
    retained within a recording; each new call starts an unrelated stream.
    """
    import numpy as np

    batch_type, preprocessor_type = load_annie_api(source_root)
    values = np.asarray(samples, dtype=np.float64)
    if sampling_rate != 250.0 or values.ndim != 2 or values.shape[1] != len(channel_names):
        raise ValueError("bridge requires sample-by-channel data at 250 Hz")
    preprocessor = preprocessor_type(
        remove_dc_offset=True, bandpass=(1.0, 40.0), notch_frequency_hz=None, quality_max_amplitude=500.0
    )
    processed = np.empty_like(values)
    usable = np.ones(len(values), dtype=bool)
    for start in range(0, len(values), 250):
        stop = min(start + 250, len(values))
        indices = np.arange(start, stop, dtype=np.int64)
        batch = batch_type(
            samples=values[start:stop],
            timestamps=indices / sampling_rate,
            sample_indices=indices,
            channel_names=tuple(channel_names),
            sampling_frequency_hz=sampling_rate,
            signal_units="uV",
        )
        result = preprocessor.process(batch)
        processed[start:stop] = result.samples
        quality = result.quality
        if (
            quality["missing_sample_count"]
            or quality["non_finite_sample_count"]
            or quality["flatline_channels"]
            or quality["excessive_amplitude_channels"]
        ):
            usable[start:stop] = False
    return processed, usable
