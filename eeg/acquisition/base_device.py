"""Hardware-independent interfaces for EEG acquisition devices."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

import numpy as np
from numpy.typing import NDArray


FloatArray = NDArray[np.float64]
IntArray = NDArray[np.int64]


@dataclass(frozen=True)
class SampleBatch:
    """A batch of EEG samples and the metadata needed to interpret it.

    ``samples`` has shape ``(sample_count, channel_count)`` and contains
    voltage values in ``signal_units``. ``timestamps`` has shape
    ``(sample_count,)`` and contains acquisition times in seconds from the
    device stream's clock. ``sample_indices`` has shape ``(sample_count,)``
    and contains consecutive, zero-based indices for the device stream.
    """

    samples: FloatArray
    timestamps: FloatArray
    sample_indices: IntArray
    channel_names: tuple[str, ...]
    sampling_frequency_hz: float
    signal_units: str

    def __post_init__(self) -> None:
        """Validate array dimensions and metadata consistency."""
        if self.samples.ndim != 2:
            raise ValueError("samples must have shape (sample_count, channel_count)")
        sample_count, channel_count = self.samples.shape
        if self.timestamps.shape != (sample_count,):
            raise ValueError("timestamps must have shape (sample_count,)")
        if self.sample_indices.shape != (sample_count,):
            raise ValueError("sample_indices must have shape (sample_count,)")
        if len(self.channel_names) != channel_count:
            raise ValueError("channel_names must match the sample channel count")
        if self.sampling_frequency_hz <= 0:
            raise ValueError("sampling_frequency_hz must be positive")
        if not self.signal_units:
            raise ValueError("signal_units must not be empty")


class EEGDevice(ABC):
    """Abstract lifecycle and acquisition interface for an EEG device."""

    @abstractmethod
    def connect(self) -> None:
        """Connect to the device."""

    @abstractmethod
    def disconnect(self) -> None:
        """Disconnect from the device."""

    @abstractmethod
    def start_streaming(self) -> None:
        """Start acquiring samples."""

    @abstractmethod
    def get_samples(self, num_samples: int = 1) -> SampleBatch:
        """Return the next ``num_samples`` samples from the active stream."""

    @abstractmethod
    def stop_streaming(self) -> None:
        """Stop acquiring samples."""

    @abstractmethod
    def get_device_info(self) -> dict[str, Any]:
        """Return descriptive device metadata."""


class DeviceStateError(RuntimeError):
    """Raised when an operation is incompatible with the device state."""
