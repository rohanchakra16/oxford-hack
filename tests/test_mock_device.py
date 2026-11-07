import numpy as np
import pytest

from eeg.acquisition import DeviceStateError, MockEEGDevice


def test_mock_device_connection_and_streaming() -> None:
    device = MockEEGDevice(sampling_frequency_hz=100, channel_count=3, seed=7)

    with pytest.raises(DeviceStateError):
        device.start_streaming()

    device.connect()
    assert device.get_device_info()["connected"] is True
    with pytest.raises(DeviceStateError):
        device.connect()

    device.start_streaming()
    batch = device.get_samples(5)

    assert batch.samples.shape == (5, 3)
    assert batch.timestamps.shape == (5,)
    assert batch.sample_indices.shape == (5,)
    assert batch.channel_names == ("EEG1", "EEG2", "EEG3")
    assert batch.sampling_frequency_hz == 100
    assert batch.signal_units == "uV"
    np.testing.assert_array_equal(batch.sample_indices, [0, 1, 2, 3, 4])
    np.testing.assert_allclose(batch.timestamps, np.arange(5) / 100)


def test_mock_device_is_deterministic_with_seed() -> None:
    def read_batch() -> np.ndarray:
        device = MockEEGDevice(sampling_frequency_hz=1000, channel_count=2, seed=42)
        device.connect()
        device.start_streaming()
        return device.get_samples(4).samples

    np.testing.assert_array_equal(read_batch(), read_batch())


def test_mock_device_indices_continue_and_shutdown_is_safe() -> None:
    device = MockEEGDevice(sampling_frequency_hz=1000, channel_count=1)
    device.connect()
    device.start_streaming()
    first = device.get_samples(2)
    device.disconnect()

    assert device.get_device_info()["connected"] is False
    assert device.get_device_info()["streaming"] is False
    np.testing.assert_array_equal(first.sample_indices, [0, 1])
    with pytest.raises(DeviceStateError):
        device.stop_streaming()
    with pytest.raises(DeviceStateError):
        device.get_samples()
