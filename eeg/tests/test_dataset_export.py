import numpy as np
import pytest

from eeg.acquisition.base_device import SampleBatch
from eeg.dataset import (
    DatasetExportError,
    DatasetExporter,
    DatasetLoadError,
    DatasetLoader,
    RecordingAnnotation,
    RecordingDatabase,
)


def make_batch() -> SampleBatch:
    return SampleBatch(
        samples=np.arange(12, dtype=float).reshape(4, 3),
        timestamps=np.arange(4, dtype=float) / 100,
        sample_indices=np.arange(10, 14, dtype=np.int64),
        channel_names=("C3", "C4", "Cz"),
        sampling_frequency_hz=100,
        signal_units="uV",
    )


def make_database(tmp_path):
    database = RecordingDatabase(tmp_path / "recordings.sqlite", tmp_path / "data")
    metadata = database.create_recording("focused", make_batch())
    database.add_annotation(RecordingAnnotation(metadata.recording_id, "task", 10, 12))
    return database, metadata


@pytest.mark.parametrize("suffix", [".npz", ".csv"])
def test_export_load_round_trip(tmp_path, suffix) -> None:
    database, metadata = make_database(tmp_path)
    exporter = DatasetExporter(database)
    destination = tmp_path / f"export{suffix}"
    exporter.export_recording(metadata.recording_id, destination)

    recording = DatasetLoader().load(destination)
    np.testing.assert_array_equal(recording.sample_batch.samples, make_batch().samples)
    np.testing.assert_array_equal(recording.sample_batch.sample_indices, np.arange(10, 14))
    assert recording.sample_batch.channel_names == ("C3", "C4", "Cz")
    assert recording.metadata.label == "focused"
    assert recording.annotations[0].label == "task"
    database.close()


def test_export_selection_and_json_metadata(tmp_path) -> None:
    database, first = make_database(tmp_path)
    second = database.create_recording("relaxed", make_batch())
    exporter = DatasetExporter(database)
    paths = exporter.export_by_label("focused", tmp_path / "labelled", "json")
    assert len(paths) == 1
    selected = exporter.export_selected(
        [second.recording_id, first.recording_id], tmp_path / "selected", "npz"
    )
    assert [path.stem for path in selected] == [str(second.recording_id), str(first.recording_id)]
    assert len(exporter.export_all(tmp_path / "all", "npz")) == 2
    database.close()


def test_loader_rejects_corrupt_npz(tmp_path) -> None:
    path = tmp_path / "corrupt.npz"
    np.savez(path, samples=np.zeros((1, 1)))
    with pytest.raises(DatasetLoadError):
        DatasetLoader().load(path)
