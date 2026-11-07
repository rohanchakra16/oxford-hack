"""EEG acquisition interfaces and simulated devices."""

from .base_device import DeviceStateError, EEGDevice, SampleBatch
from .factory import create_device
from .mock_device import MockEEGDevice
from .unicorn_device import UnicornEEGDevice, UnicornSDKError

__all__ = [
    "DeviceStateError",
    "EEGDevice",
    "MockEEGDevice",
    "SampleBatch",
    "UnicornEEGDevice",
    "UnicornSDKError",
    "create_device",
]
