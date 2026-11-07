import numpy as np

from eeg.acquisition.base_device import SampleBatch
from eeg.dataset import RecordingAnnotation, RecordingDatabase


def make_batch() -> SampleBatch:
    return SampleBatch(
        samples=np.arange(12, dtype=float).reshape(4, 3),
        timestamps=np.arange(4, dtype=float) / 100,
        sample_indices=np.arange(10, 14, dtype=np.int64),
        channel_names=("C3", "C4", "Cz"),
        sampling_frequency_hz=100,
        signal_units="uV",
    )


def test_recording_crud_and_raw_metadata_persistence(tmp_path) -> None:
    database_path = tmp_path / "recordings.sqlite"
    data_dir = tmp_path / "data"
    database = RecordingDatabase(database_path, data_dir)
    metadata = database.create_recording(
        "focused", make_batch(), device_name="mock", device_serial="M-1"
    )
    assert metadata.recording_id
    assert len(database.list_recordings()) == 1
    assert len(database.list_recordings_by_label("focused")) == 1

    annotation = database.add_annotation(
        RecordingAnnotation(metadata.recording_id, "task", 10, 12, "start")
    )
    recording = database.get_recording(metadata.recording_id)
    assert recording is not None
    np.testing.assert_array_equal(recording.sample_batch.samples, make_batch().samples)
    assert recording.sample_batch.channel_names == ("C3", "C4", "Cz")
    assert recording.annotations == (annotation,)

    updated = database.update_recording(
        type(metadata)(**{**metadata.__dict__, "label": "rest"})
    )
    assert updated.label == "rest"
    database.close()

    reopened = RecordingDatabase(database_path, data_dir)
    assert reopened.get_recording(metadata.recording_id).metadata.label == "rest"
    assert reopened.delete_recording(metadata.recording_id) is True
    assert not list(data_dir.glob("*.npz"))
    assert reopened.get_recording(metadata.recording_id) is None
    reopened.close()


def test_recording_ids_are_unique(tmp_path) -> None:
    database = RecordingDatabase(tmp_path / "db.sqlite", tmp_path / "data")
    first = database.create_recording("a", make_batch())
    second = database.create_recording("b", make_batch())
    assert first.recording_id != second.recording_id
