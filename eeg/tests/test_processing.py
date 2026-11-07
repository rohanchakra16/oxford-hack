import numpy as np

from eeg.acquisition.base_device import SampleBatch
from eeg.processing import EEGBuffer, EEGPreprocessor


def batch(values: np.ndarray, start: int = 0, fs: float = 100.0) -> SampleBatch:
    indices = np.arange(start, start + len(values), dtype=np.int64)
    return SampleBatch(
        samples=values,
        timestamps=indices / fs,
        sample_indices=indices,
        channel_names=tuple(f"EEG{i}" for i in range(values.shape[1])),
        sampling_frequency_hz=fs,
        signal_units="uV",
    )


def test_buffer_order_timestamps_gaps_overflow_and_reset() -> None:
    buffer = EEGBuffer(capacity_seconds=0.05, sampling_frequency_hz=100)
    buffer.append(batch(np.arange(4, dtype=float)[:, None]))
    buffer.append(batch(np.arange(4, 7, dtype=float)[:, None], start=5))

    recent = buffer.get_recent(0.05)
    np.testing.assert_array_equal(recent.sample_indices, [2, 3, 5, 6, 7])
    np.testing.assert_array_equal(recent.timestamps, [.02, .03, .05, .06, .07])
    status = buffer.status()
    assert status.gap_count == 1
    assert status.dropped_sample_count == 3
    assert status.overflowed is True
    buffer.reset()
    assert buffer.status().sample_count == 0


def test_preprocessor_quality_and_stateful_filtering() -> None:
    fs = 100.0
    t = np.arange(200) / fs
    values = (np.sin(2 * np.pi * 10 * t) + 2).reshape(-1, 1)
    first = batch(values[:100], fs=fs)
    second = batch(values[100:], start=100, fs=fs)
    preprocessor = EEGPreprocessor(bandpass=(1, 40), quality_max_amplitude=10)
    processed_first = preprocessor.process(first)
    processed_second = preprocessor.process(second)
    one_pass = EEGPreprocessor(bandpass=(1, 40), quality_max_amplitude=10).process(
        batch(values, fs=fs)
    )

    np.testing.assert_allclose(
        np.vstack((processed_first.samples, processed_second.samples)),
        one_pass.samples,
        atol=1e-10,
    )
    assert processed_second.quality["missing_sample_count"] == 0
    assert processed_first.quality["non_finite_sample_count"] == 0
