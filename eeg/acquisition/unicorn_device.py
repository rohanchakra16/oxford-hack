"""Adapter for the g.tec UnicornPy SDK.

The official Unicorn Python API is an optional, vendor-supplied dependency.
It is not bundled with this project and is intentionally imported lazily.
The adapter uses the documented UnicornPy calls:
``GetAvailableDevices``, ``Unicorn``, ``GetConfiguration``,
``GetNumberOfAcquiredChannels``, ``StartAcquisition``, ``GetData``,
``StopAcquisition``, and ``Close``.

Unicorn data contains EEG and auxiliary channels (accelerometer, gyroscope,
battery, counter, and validation indicator). This adapter preserves every
enabled channel in the SDK's returned order; it does not silently discard
auxiliary data. Channel type and unit metadata are available in
``get_device_info()["channels"]``.
"""

from __future__ import annotations

import importlib
import struct
import time
from types import ModuleType
from typing import Any

import numpy as np

from .base_device import DeviceStateError, EEGDevice, SampleBatch


class UnicornSDKError(RuntimeError):
    """Raised when the Unicorn SDK cannot complete an operation."""


def _load_sdk() -> ModuleType:
    """Load the vendor SDK without making it a project dependency."""
    try:
        return importlib.import_module("UnicornPy")
    except ImportError as error:
        raise UnicornSDKError(
            "The g.tec UnicornPy SDK is unavailable. Install the vendor SDK "
            "and ensure UnicornPy is importable before using UnicornEEGDevice."
        ) from error


class UnicornEEGDevice(EEGDevice):
    """Physical g.tec Unicorn adapter with no simulated-data fallback."""

    def __init__(
        self,
        serial: str | None = None,
        sdk_module: ModuleType | Any | None = None,
        only_paired: bool = True,
    ) -> None:
        self._sdk = sdk_module
        self._serial = serial
        self._only_paired = only_paired
        self._device: Any | None = None
        self._connected = False
        self._streaming = False
        self._sample_index = 0
        self._channel_names: tuple[str, ...] = ()
        self._channel_units: tuple[str, ...] = ()
        self._channel_types: tuple[str, ...] = ()
        self._sampling_frequency_hz = 0.0
        self._timestamp_source = "host_monotonic_at_retrieval"
        self._device_info: dict[str, Any] = {}

    @classmethod
    def discover(
        cls,
        sdk_module: ModuleType | Any | None = None,
        only_paired: bool = True,
    ) -> tuple[str, ...]:
        """Return serials discovered by the SDK, without opening a device."""
        sdk = sdk_module or _load_sdk()
        try:
            devices = sdk.GetAvailableDevices(only_paired)
        except Exception as error:
            raise UnicornSDKError("Unicorn device discovery failed") from error
        return tuple(_decode_text(serial) for serial in devices)

    def connect(self) -> None:
        if self._connected:
            raise DeviceStateError("Device is already connected")
        sdk = self._sdk or _load_sdk()
        serial = self._serial
        if serial is None:
            devices = self.discover(sdk, self._only_paired)
            if not devices:
                raise UnicornSDKError("No Unicorn devices were discovered")
            serial = devices[0]
        # _load_configuration reads SDK constants (SamplingRate), so the resolved SDK module must be
        # assigned before it runs; otherwise an auto-loaded SDK (no injected module) is still None there.
        self._sdk = sdk
        self._serial = serial
        try:
            self._device = sdk.Unicorn(serial)
            self._load_configuration()
        except Exception as error:
            self._device = None
            self._connected = False
            raise UnicornSDKError(f"Unable to connect to Unicorn {serial!r}") from error
        self._connected = True

    def disconnect(self) -> None:
        if not self._connected:
            return
        stop_error: Exception | None = None
        if self._streaming:
            try:
                self.stop_streaming()
            except Exception as error:
                stop_error = error
        try:
            if self._device is not None:
                self._device.Close()
        except Exception as error:
            if stop_error is None:
                stop_error = UnicornSDKError("Unable to close Unicorn device")
                stop_error.__cause__ = error
        finally:
            self._device = None
            self._connected = False
            self._streaming = False
        if stop_error is not None:
            raise stop_error

    def start_streaming(self) -> None:
        self._require_connected()
        if self._streaming:
            raise DeviceStateError("Device is already streaming")
        try:
            self._device.StartAcquisition(False)
        except Exception as error:
            raise UnicornSDKError("Unable to start Unicorn acquisition") from error
        self._streaming = True

    def get_samples(self, num_samples: int = 1) -> SampleBatch:
        self._require_streaming()
        if isinstance(num_samples, bool) or not isinstance(num_samples, int):
            raise TypeError("num_samples must be an integer")
        if num_samples <= 0:
            raise ValueError("num_samples must be positive")

        channel_count = len(self._channel_names)
        buffer_length = num_samples * channel_count * struct.calcsize("f")
        data_buffer = bytearray(buffer_length)
        acquired_at = time.monotonic()
        try:
            self._device.GetData(num_samples, data_buffer, buffer_length)
        except Exception as error:
            raise UnicornSDKError(
                "Unicorn acquisition failed; no samples were returned"
            ) from error

        values = np.frombuffer(data_buffer, dtype="<f4").astype(np.float64)
        if values.size != num_samples * channel_count:
            raise UnicornSDKError(
                "Unicorn SDK returned an unexpected sample buffer length"
            )
        samples = values.reshape((num_samples, channel_count))
        indices = np.arange(
            self._sample_index, self._sample_index + num_samples, dtype=np.int64
        )
        timestamps = acquired_at + np.arange(num_samples, dtype=np.float64) / (
            self._sampling_frequency_hz
        )
        self._sample_index += num_samples
        return SampleBatch(
            samples=samples,
            timestamps=timestamps,
            sample_indices=indices,
            channel_names=self._channel_names,
            sampling_frequency_hz=self._sampling_frequency_hz,
            signal_units=(
                self._channel_units[0]
                if len(set(self._channel_units)) == 1
                else "mixed; see device_info['channels']"
            ),
        )

    def stop_streaming(self) -> None:
        self._require_connected()
        if not self._streaming:
            raise DeviceStateError("Device is not streaming")
        try:
            self._device.StopAcquisition()
        except Exception as error:
            raise UnicornSDKError("Unable to stop Unicorn acquisition") from error
        self._streaming = False

    def get_device_info(self) -> dict[str, Any]:
        return {
            **self._device_info,
            "device_type": "gtec_unicorn",
            "sampling_frequency_hz": self._sampling_frequency_hz,
            "serial": self._serial,
            "connected": self._connected,
            "streaming": self._streaming,
            "timestamp_source": self._timestamp_source,
            "channels": [
                {"name": name, "type": kind, "unit": unit}
                for name, kind, unit in zip(
                    self._channel_names, self._channel_types, self._channel_units
                )
            ],
        }

    def _load_configuration(self) -> None:
        if self._device is None:
            raise DeviceStateError("Device is not connected")
        try:
            channel_count = self._device.GetNumberOfAcquiredChannels()
            configuration = self._device.GetConfiguration()
            sampling_frequency = getattr(self._sdk, "SamplingRate")
            channels = tuple(configuration.AmplifierChannels)
        except (AttributeError, TypeError) as error:
            raise UnicornSDKError(
                "Unicorn SDK did not provide the required device configuration"
            ) from error

        enabled_channels = tuple(channel for channel in channels if channel.Enabled)
        if len(enabled_channels) != channel_count:
            raise UnicornSDKError(
                "Unicorn SDK channel configuration does not match acquired count"
            )
        self._channel_names = tuple(_decode_text(channel.Name) for channel in enabled_channels)
        self._channel_units = tuple(_decode_text(channel.Unit) for channel in enabled_channels)
        self._channel_types = tuple(
            _channel_type(channel.Name) for channel in enabled_channels
        )
        self._sampling_frequency_hz = float(sampling_frequency)
        if self._sampling_frequency_hz <= 0:
            raise UnicornSDKError("Unicorn SDK reported an invalid sampling rate")
        try:
            info = self._device.GetDeviceInformation()
        except AttributeError:
            info = None
        if info is not None:
            self._device_info = {
                key: value
                for key, value in {
                    "firmware_version": getattr(info, "FwVersion", None),
                    "device_version": getattr(info, "DeviceVersion", None),
                    "serial": getattr(info, "Serial", self._serial),
                }.items()
                if value is not None
            }

    def _require_connected(self) -> None:
        if not self._connected or self._device is None:
            raise DeviceStateError("Device must be connected")

    def _require_streaming(self) -> None:
        self._require_connected()
        if not self._streaming:
            raise DeviceStateError("Device must be streaming")


def _decode_text(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8").rstrip("\x00")
    return str(value)


def _channel_type(name: Any) -> str:
    """Classify known Unicorn auxiliary labels without changing their order."""
    label = _decode_text(name).lower()
    if label.startswith(("acc", "accelerometer")):
        return "accelerometer"
    if label.startswith(("gyr", "gyro", "gyroscope")):
        return "gyroscope"
    if label.startswith(("batt", "battery")):
        return "battery"
    if label.startswith(("count", "counter")):
        return "counter"
    if label.startswith(("valid", "validation")):
        return "validation"
    if label.startswith(("eeg", "e")):
        return "eeg"
    return "unknown"
