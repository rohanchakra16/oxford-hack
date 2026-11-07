"""Construction of supported EEG acquisition devices."""

from __future__ import annotations

from typing import Any

from .base_device import EEGDevice
from .mock_device import MockEEGDevice
from .unicorn_device import UnicornEEGDevice


def create_device(device_type: str, **kwargs: Any) -> EEGDevice:
    """Create a supported device adapter without falling back silently."""
    if device_type == "mock":
        return MockEEGDevice(**kwargs)
    if device_type == "unicorn":
        return UnicornEEGDevice(**kwargs)
    raise ValueError(f"Unsupported EEG device type: {device_type!r}")
