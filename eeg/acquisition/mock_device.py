"""Deterministic, hardware-independent simulated EEG device."""

from __future__ import annotations

import time
from typing import Any

import numpy as np

from .base_device import DeviceStateError, EEGDevice, SampleBatch


class MockEEGDevice(EEGDevice):
    """Generate multichannel oscillatory EEG-like signals with noise.

    Samples are returned in rows with shape ``(sample_count, channel_count)``.
    Signal values are in microvolts, timestamps are seconds, and sample
    indices start at zero and continue across streaming sessions until the
    device is disconnected.
    """

    def __init__(
        self,
        sampling_frequency_hz: float = 250.0,
        channel_count: int = 8,
        channel_names: tuple[str, ...] | list[str] | None = None,
        seed: int | None = None,
        noise_standard_deviation_uv: float = 2.0,
    ) -> None:
        if sampling_frequency_hz <= 0:
            raise ValueError("sampling_frequency_hz must be positive")
        if channel_count <= 0:
            raise ValueError("channel_count must be positive")
        if noise_standard_deviation_uv < 0:
            raise ValueError("noise_standard_deviation_uv must not be negative")

        names = tuple(channel_names or (f"EEG{i + 1}" for i in range(channel_count)))
        if len(names) != channel_count or any(not name for name in names):
            raise ValueError("channel_names must contain one non-empty name per channel")

        self._sampling_frequency_hz = float(sampling_frequency_hz)
        self._channel_count = channel_count
        self._channel_names = names
        self._noise_standard_deviation_uv = float(noise_standard_deviation_uv)
        self._rng = np.random.default_rng(seed)
        self._connected = False
        self._streaming = False
        self._next_sample_index = 0
        self._stream_start_time = 0.0
        self._next_sample_deadline = 0.0

    def connect(self) -> None:
        if self._connected:
            raise DeviceStateError("Device is already connected")
        self._connected = True

    def disconnect(self) -> None:
        if not self._connected:
            return
        if self._streaming:
            self.stop_streaming()
        self._connected = False

    def start_streaming(self) -> None:
        if not self._connected:
            raise DeviceStateError("Device must be connected before streaming")
        if self._streaming:
            raise DeviceStateError("Device is already streaming")
        self._streaming = True
        now = time.monotonic()
        self._stream_start_time = now
        self._next_sample_deadline = now

    def get_samples(self, num_samples: int = 1) -> SampleBatch:
        if not self._streaming:
            raise DeviceStateError("Device must be streaming to get samples")
        if isinstance(num_samples, bool) or num_samples <= 0:
            raise ValueError("num_samples must be a positive integer")
        if not isinstance(num_samples, int):
            raise TypeError("num_samples must be an integer")

        self._next_sample_deadline += num_samples / self._sampling_frequency_hz
        delay = self._next_sample_deadline - time.monotonic()
        if delay > 0:
            time.sleep(delay)

        start_index = self._next_sample_index
        indices = np.arange(start_index, start_index + num_samples, dtype=np.int64)
        timestamps = indices.astype(np.float64) / self._sampling_frequency_hz
        frequencies = np.linspace(8.0, 12.0, self._channel_count)
        phases = np.linspace(0.0, np.pi / 3.0, self._channel_count)
        oscillations = 20.0 * np.sin(
            2.0 * np.pi * timestamps[:, np.newaxis] * frequencies + phases
        )
        noise = self._rng.normal(
            0.0,
            self._noise_standard_deviation_uv,
            size=(num_samples, self._channel_count),
        )
        self._next_sample_index += num_samples
        return SampleBatch(
            samples=oscillations + noise,
            timestamps=timestamps,
            sample_indices=indices,
            channel_names=self._channel_names,
            sampling_frequency_hz=self._sampling_frequency_hz,
            signal_units="uV",
        )

    def stop_streaming(self) -> None:
        if not self._streaming:
            raise DeviceStateError("Device is not streaming")
        self._streaming = False

    def get_device_info(self) -> dict[str, Any]:
        return {
            "device_type": "mock",
            "channel_count": self._channel_count,
            "channel_names": self._channel_names,
            "sampling_frequency_hz": self._sampling_frequency_hz,
            "signal_units": "uV",
            "connected": self._connected,
            "streaming": self._streaming,
        }
