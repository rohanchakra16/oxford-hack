import logging
import time
import tracemalloc

import numpy as np

from eeg.acquisition import MockEEGDevice
from eeg.dataset import RecordingDatabase, RecordingManager, RecordingState
from eeg.processing.signal_preprocessor import EEGPreprocessor
from eeg.realtime.attention_classifier import StubAttentionClassifier
from eeg.realtime.feature_extractor import EEGFeatureExtractor
from eeg.realtime.feature_registry import FeatureRegistry
from eeg.realtime.streaming_controller import StreamingController


def _wait_for_samples(manager: RecordingManager) -> None:
    """Wait for asynchronous acquisition without making the test timing-dependent."""
    deadline = time.monotonic() + 2
    while manager.get_recording_status().sample_count == 0:
        if time.monotonic() >= deadline:
            raise AssertionError("mock device did not produce samples")
        time.sleep(0.01)


def _make_pipeline(device: MockEEGDevice) -> StreamingController:
    """Build the same replaceable processing components used by the application."""
    registry = FeatureRegistry()
    registry.register(
        "custom_training_feature",
        lambda window, rate, info, config=None: float(np.mean(window)),
    )
    return StreamingController(
        device,
        EEGPreprocessor(bandpass=None),
        EEGFeatureExtractor(registry),
        StubAttentionClassifier(expected_features=("custom_training_feature",)),
        output_capacity=8,
    )


def test_dataset_save_reload_and_discard_audit(tmp_path) -> None:
    """Verify that saving preserves raw data and discarding creates no row."""
    database = RecordingDatabase(tmp_path / "recordings.sqlite", tmp_path / "data")
    device = MockEEGDevice(sampling_frequency_hz=100, channel_count=2, seed=7)
    device.connect()
    manager = RecordingManager(device, database, batch_size=10)

    manager.start_recording("Focused")
    _wait_for_samples(manager)
    manager.stop_recording()
    # Stopping ends acquisition but leaves the recording pending an explicit decision.
    assert manager.get_recording_status().state is RecordingState.REVIEW_PENDING
    metadata = manager.save_recording()
    # Reload through SQLite and NPZ to verify persistence rather than in-memory state.
    loaded = database.get_recording(metadata.recording_id)
    assert loaded is not None
    assert loaded.metadata.label == "Focused"
    assert loaded.metadata.sampling_rate == 100
    assert loaded.metadata.channel_names == ("EEG1", "EEG2")
    assert loaded.sample_batch.samples.shape[1] == 2
    np.testing.assert_array_equal(
        loaded.sample_batch.sample_indices,
        np.arange(loaded.metadata.sample_count),
    )

    manager.start_recording("Discarded")
    _wait_for_samples(manager)
    manager.stop_recording()
    manager.discard_recording()
    # The discarded session must not appear alongside the saved recording.
    assert database.list_recordings_by_label("Discarded") == []
    assert len(database.list_recordings()) == 1
    device.disconnect()
    database.close()


def test_realtime_audit_logs_frames_and_reports_resources(caplog) -> None:
    """Verify one complete streaming frame and the reported runtime metrics."""
    caplog.set_level(logging.INFO, logger="eeg.realtime.streaming_controller")
    device = MockEEGDevice(sampling_frequency_hz=100, channel_count=2, seed=9)
    device.connect()
    controller = _make_pipeline(device)
    tracemalloc.start()
    started = time.perf_counter()
    controller.start()
    frame = controller.get_frame(timeout=4)
    controller.stop()
    # Metrics are collected around the asynchronous producer-consumer pipeline.
    elapsed = time.perf_counter() - started
    _, peak_memory = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    stats = controller.get_stats()
    assert frame["sample_indices"][1] >= frame["sample_indices"][0]
    assert frame["prediction"]["model_type"] == "stub"
    # Each stage reports a measured latency even when the result is a stub.
    assert stats.acquisition_latency_ms >= 0
    assert stats.preprocessing_latency_ms >= 0
    assert stats.feature_latency_ms >= 0
    assert stats.classification_latency_ms >= 0
    assert stats.total_processing_latency_ms >= 0
    assert stats.missed_update_deadlines == 0
    assert elapsed > 0
    assert peak_memory > 0
    assert "EEG frame=" in caplog.text
    assert not controller._threads
    device.disconnect()
