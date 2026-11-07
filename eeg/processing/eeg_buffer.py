"""Thread-safe circular buffering for timestamped EEG sample batches."""

from __future__ import annotations

from dataclasses import dataclass
from threading import RLock

import numpy as np

from eeg.acquisition.base_device import SampleBatch


@dataclass(frozen=True)
class BufferStatus:
    """Acquisition continuity and circular-buffer state."""

    sample_count: int
    dropped_sample_count: int
    gap_count: int
    overflowed: bool
    last_sample_index: int | None


class EEGBuffer:
    """Bounded, thread-safe circular buffer preserving sample relationships."""

    def __init__(self, capacity_seconds: float, sampling_frequency_hz: float) -> None:
        if capacity_seconds <= 0 or sampling_frequency_hz <= 0:
            raise ValueError("capacity_seconds and sampling_frequency_hz must be positive")
        self._capacity = max(1, int(np.ceil(capacity_seconds * sampling_frequency_hz)))
        self._sampling_frequency_hz = float(sampling_frequency_hz)
        self._samples: np.ndarray | None = None
        self._timestamps = np.empty(0, dtype=np.float64)
        self._indices = np.empty(0, dtype=np.int64)
        self._channel_names: tuple[str, ...] = ()
        self._signal_units = ""
        self._dropped_sample_count = 0
        self._gap_count = 0
        self._overflowed = False
        self._last_sample_index: int | None = None
        self._lock = RLock()

    @property
    def capacity_samples(self) -> int:
        return self._capacity

    def append(self, batch: SampleBatch) -> None:
        """Append a batch, recording gaps and samples evicted by capacity."""
        with self._lock:
            if batch.sampling_frequency_hz != self._sampling_frequency_hz:
                raise ValueError("Batch sampling frequency does not match buffer")
            if self._samples is None:
                self._samples = np.empty((0, batch.samples.shape[1]), dtype=np.float64)
                self._channel_names = batch.channel_names
                self._signal_units = batch.signal_units
            elif batch.channel_names != self._channel_names:
                raise ValueError("Batch channel names do not match buffer")

            if self._last_sample_index is not None:
                gap = int(batch.sample_indices[0] - self._last_sample_index - 1)
                if gap > 0:
                    self._gap_count += 1
                    self._dropped_sample_count += gap
            self._last_sample_index = int(batch.sample_indices[-1])

            samples = np.concatenate((self._samples, batch.samples), axis=0)
            timestamps = np.concatenate((self._timestamps, batch.timestamps))
            indices = np.concatenate((self._indices, batch.sample_indices))
            if samples.shape[0] > self._capacity:
                evicted = samples.shape[0] - self._capacity
                self._dropped_sample_count += evicted
                self._overflowed = True
                samples = samples[-self._capacity :]
                timestamps = timestamps[-self._capacity :]
                indices = indices[-self._capacity :]
            self._samples = samples
            self._timestamps = timestamps
            self._indices = indices

    def get_recent(self, seconds: float) -> SampleBatch:
        """Return the newest samples covering at most ``seconds``."""
        if seconds <= 0:
            raise ValueError("seconds must be positive")
        with self._lock:
            if self._samples is None or not len(self._indices):
                raise ValueError("Buffer is empty")
            count = max(1, int(np.ceil(seconds * self._sampling_frequency_hz)))
            start = max(0, len(self._indices) - count)
            return SampleBatch(
                samples=self._samples[start:].copy(),
                timestamps=self._timestamps[start:].copy(),
                sample_indices=self._indices[start:].copy(),
                channel_names=self._channel_names,
                sampling_frequency_hz=self._sampling_frequency_hz,
                signal_units=self._signal_units,
            )

    def status(self) -> BufferStatus:
        with self._lock:
            return BufferStatus(
                sample_count=len(self._indices),
                dropped_sample_count=self._dropped_sample_count,
                gap_count=self._gap_count,
                overflowed=self._overflowed,
                last_sample_index=self._last_sample_index,
            )

    def reset(self) -> None:
        with self._lock:
            self._samples = None
            self._timestamps = np.empty(0, dtype=np.float64)
            self._indices = np.empty(0, dtype=np.int64)
            self._channel_names = ()
            self._signal_units = ""
            self._dropped_sample_count = 0
            self._gap_count = 0
            self._overflowed = False
            self._last_sample_index = None
