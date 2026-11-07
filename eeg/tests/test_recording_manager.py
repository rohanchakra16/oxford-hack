import time

import pytest

from eeg.acquisition import MockEEGDevice
from eeg.dataset import (
    RecordingDatabase,
    RecordingManager,
    RecordingManagerError,
    RecordingState,
)
from eeg.realtime.feature_extractor import EEGFeatureExtractor
from eeg.realtime.feature_registry import FeatureRegistry


def wait_for_samples(manager: RecordingManager) -> None:
    deadline = time.monotonic() + 2
    while manager.get_recording_status().sample_count == 0 and time.monotonic() < deadline:
        time.sleep(0.01)


def make_manager(tmp_path, batch_size: int = 10) -> tuple[RecordingManager, RecordingDatabase]:
    database = RecordingDatabase(tmp_path / "recordings.sqlite", tmp_path / "data")
    device = MockEEGDevice(sampling_frequency_hz=1000, channel_count=2, seed=4)
    device.connect()
    return RecordingManager(device, database, batch_size=batch_size), database


def test_recording_manager_start_stop_save(tmp_path) -> None:
    manager, database = make_manager(tmp_path)
    with pytest.raises(RecordingManagerError):
        manager.save_recording()
    manager.start_recording("focused")
    wait_for_samples(manager)
    assert manager.get_recording_status().state is RecordingState.RECORDING
    manager.stop_recording()
    assert manager.get_recording_status().state is RecordingState.REVIEW_PENDING
    metadata = manager.save_recording()
    assert manager.get_recording_status().state is RecordingState.IDLE
    assert database.get_recording(metadata.recording_id) is not None
    database.close()


def test_recording_manager_discard_does_not_persist(tmp_path) -> None:
    manager, database = make_manager(tmp_path)
    manager.start_recording("discarded")
    wait_for_samples(manager)
    manager.stop_recording()
    manager.discard_recording()
    assert manager.get_recording_status().state is RecordingState.IDLE
    assert database.list_recordings() == []
    database.close()


def test_recording_manager_requires_explicit_decision(tmp_path) -> None:
    manager, database = make_manager(tmp_path)
    manager.start_recording("one")
    wait_for_samples(manager)
    manager.stop_recording()
    with pytest.raises(RecordingManagerError):
        manager.start_recording("two")
    with pytest.raises(RecordingManagerError):
        manager.stop_recording()
    manager.discard_recording()
    database.close()


def test_interrupted_save_retains_review_session(tmp_path, monkeypatch) -> None:
    manager, database = make_manager(tmp_path)
    manager.start_recording("retry")
    wait_for_samples(manager)
    manager.stop_recording()

    def fail_save(*_args, **_kwargs):
        raise OSError("disk unavailable")

    monkeypatch.setattr(database, "create_recording", fail_save)
    with pytest.raises(RecordingManagerError, match="temporary data remains"):
        manager.save_recording()
    status = manager.get_recording_status()
    assert status.state is RecordingState.REVIEW_PENDING
    assert status.sample_count > 0
    manager.discard_recording()
    database.close()


def test_save_persists_separate_training_features(tmp_path) -> None:
    database = RecordingDatabase(tmp_path / "recordings.sqlite", tmp_path / "data")
    device = MockEEGDevice(sampling_frequency_hz=1000, channel_count=2, seed=4)
    device.connect()
    registry = FeatureRegistry()
    registry.register("sample_count", lambda window, rate, info, config=None: len(window))
    manager = RecordingManager(
        device,
        database,
        batch_size=10,
        feature_extractor=EEGFeatureExtractor(registry),
    )
    manager.start_recording("focused")
    wait_for_samples(manager)
    manager.stop_recording()
    metadata = manager.save_recording()

    assert metadata.feature_file_path
    frames = database.load_feature_frames(metadata.recording_id)
    assert frames[0]["features"]["sample_count"]["value"] > 0
    assert database.get_recording(metadata.recording_id).sample_batch.samples.shape[1] == 2
    database.close()
