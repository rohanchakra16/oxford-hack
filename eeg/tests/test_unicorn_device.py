import types

import numpy as np
import pytest

from eeg.acquisition import (
    DeviceStateError,
    UnicornEEGDevice,
    UnicornSDKError,
    create_device,
)


class FakeChannel:
    def __init__(self, name: str, unit: str, enabled: bool = True) -> None:
        self.Name = name
        self.Unit = unit
        self.Enabled = enabled


class FakeSDKDevice:
    def __init__(self, serial: str) -> None:
        self.serial = serial
        self.started = False
        self.closed = False

    def GetNumberOfAcquiredChannels(self) -> int:
        return 3

    def GetConfiguration(self) -> object:
        return types.SimpleNamespace(
            AmplifierChannels=[
                FakeChannel("EEG1", "uV"),
                FakeChannel("EEG2", "uV"),
                FakeChannel("AccelX", "g"),
            ]
        )

    def GetDeviceInformation(self) -> object:
        return types.SimpleNamespace(
            Serial=self.serial, FwVersion="1.0", DeviceVersion="2.0"
        )

    def StartAcquisition(self, test_signal: bool) -> None:
        assert test_signal is False
        self.started = True

    def GetData(self, count: int, buffer: bytearray, length: int) -> None:
        values = np.arange(count * 3, dtype="<f4")
        buffer[:] = values.tobytes()

    def StopAcquisition(self) -> None:
        self.started = False

    def Close(self) -> None:
        self.closed = True


class FakeSDK:
    SamplingRate = 250

    def __init__(self) -> None:
        self.device = None

    def GetAvailableDevices(self, only_paired: bool) -> list[str]:
        assert only_paired is True
        return ["UNICORN-001"]

    def Unicorn(self, serial: str) -> FakeSDKDevice:
        self.device = FakeSDKDevice(serial)
        return self.device


def test_unicorn_connect_stream_and_preserve_channels() -> None:
    sdk = FakeSDK()
    device = UnicornEEGDevice(sdk_module=sdk)
    device.connect()
    device.start_streaming()

    batch = device.get_samples(2)

    assert batch.samples.shape == (2, 3)
    np.testing.assert_array_equal(batch.sample_indices, [0, 1])
    assert batch.channel_names == ("EEG1", "EEG2", "AccelX")
    assert batch.sampling_frequency_hz == 250
    assert device.get_device_info()["channels"][2]["type"] == "accelerometer"
    assert device.get_device_info()["timestamp_source"] == "host_monotonic_at_retrieval"

    device.disconnect()
    assert sdk.device.closed is True


def test_unicorn_discovery_and_factory() -> None:
    sdk = FakeSDK()
    assert UnicornEEGDevice.discover(sdk) == ("UNICORN-001",)
    assert isinstance(create_device("unicorn", sdk_module=sdk), UnicornEEGDevice)
    assert isinstance(create_device("mock"), object)


def test_unicorn_rejects_sdk_errors_and_invalid_lifecycle() -> None:
    sdk = FakeSDK()
    device = UnicornEEGDevice(serial="UNICORN-001", sdk_module=sdk)
    with pytest.raises(DeviceStateError):
        device.start_streaming()
    device.connect()
    with pytest.raises(DeviceStateError):
        device.get_samples()
    device.start_streaming()
    sdk.device.GetData = lambda *_args: (_ for _ in ()).throw(RuntimeError("overflow"))
    with pytest.raises(UnicornSDKError, match="no samples"):
        device.get_samples(1)
    device.disconnect()


def test_connect_with_lazily_loaded_sdk_and_reports_sampling_rate(monkeypatch) -> None:
    # No injected sdk_module: connect() must assign the resolved SDK before reading SamplingRate,
    # and StreamingController reads sampling_frequency_hz from get_device_info().
    import eeg.acquisition.unicorn_device as module

    monkeypatch.setattr(module, "_load_sdk", lambda: FakeSDK())
    device = UnicornEEGDevice(serial="UN-1")
    device.connect()
    assert device.get_device_info()["sampling_frequency_hz"] == 250.0
    device.disconnect()


def test_failed_connect_leaves_device_disconnected() -> None:
    class BrokenSDK(FakeSDK):
        SamplingRate = 0

    device = UnicornEEGDevice(serial="UN-1", sdk_module=BrokenSDK())
    with pytest.raises(UnicornSDKError):
        device.connect()
    assert device.get_device_info()["connected"] is False
