"""EEG acquisition interfaces and simulated devices."""

from .base_device import DeviceStateError, EEGDevice, SampleBatch
from .mock_device import MockEEGDevice

__all__ = ["DeviceStateError", "EEGDevice", "MockEEGDevice", "SampleBatch"]
