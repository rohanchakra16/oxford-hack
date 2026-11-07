"""Validated loading of exported raw EEG datasets."""

from __future__ import annotations

import csv
import json
from pathlib import Path
from uuid import UUID

import numpy as np

from eeg.acquisition.base_device import SampleBatch
from .recording_metadata import Recording, RecordingAnnotation, RecordingMetadata


class DatasetLoadError(ValueError):
    """Raised when an exported dataset is missing or inconsistent."""


class DatasetLoader:
    """Reconstruct recordings from NPZ exports or CSV/JSON export pairs."""

    def load(self, path: str | Path, metadata_path: str | Path | None = None) -> Recording:
        """Load an NPZ export, or a CSV accompanied by its JSON sidecar."""
        source = Path(path)
        if not source.is_file():
            raise DatasetLoadError(f"Dataset file not found: {source}")
        suffix = source.suffix.lower()
        if suffix == ".npz":
            return self.load_npz(source)
        if suffix == ".csv":
            return self.load_csv(source, metadata_path or source.with_suffix(".json"))
        raise DatasetLoadError("load requires an NPZ file or a CSV with JSON metadata")

    def load_npz(self, path: str | Path) -> Recording:
        source = Path(path)
        try:
            with np.load(source, allow_pickle=False) as data:
                required = {
                    "samples", "timestamps", "sample_indices", "channel_names",
                    "sampling_frequency_hz", "signal_units", "metadata_json",
                }
                missing = required.difference(data.files)
                if missing:
                    raise DatasetLoadError(f"NPZ is missing fields: {sorted(missing)}")
                batch = SampleBatch(
                    samples=np.asarray(data["samples"], dtype=np.float64),
                    timestamps=np.asarray(data["timestamps"], dtype=np.float64),
                    sample_indices=np.asarray(data["sample_indices"], dtype=np.int64),
                    channel_names=tuple(str(value) for value in data["channel_names"].tolist()),
                    sampling_frequency_hz=float(data["sampling_frequency_hz"]),
                    signal_units=str(data["signal_units"].item()),
                )
                metadata = json.loads(str(data["metadata_json"].item()))
        except DatasetLoadError:
            raise
        except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
            raise DatasetLoadError(f"Unable to read NPZ dataset: {source}") from error
        return _build_recording(metadata, batch)

    def load_csv(self, path: str | Path, metadata_path: str | Path) -> Recording:
        source = Path(path)
        metadata_source = Path(metadata_path)
        try:
            metadata = json.loads(metadata_source.read_text(encoding="utf-8"))
            with source.open(newline="", encoding="utf-8") as file:
                rows = list(csv.reader(file))
            if not rows or rows[0][:2] != ["timestamp", "sample_index"]:
                raise DatasetLoadError("CSV header must start with timestamp,sample_index")
            values = np.asarray([[float(value) for value in row] for row in rows[1:]], dtype=float)
            channel_names = tuple(metadata["channel_names"])
            if values.ndim != 2 or values.shape[1] != len(channel_names) + 2:
                raise DatasetLoadError("CSV column count does not match metadata")
            batch = SampleBatch(
                samples=values[:, 2:],
                timestamps=values[:, 0],
                sample_indices=values[:, 1].astype(np.int64),
                channel_names=channel_names,
                sampling_frequency_hz=float(metadata["sampling_rate"]),
                signal_units=str(metadata["signal_units"]),
            )
        except DatasetLoadError:
            raise
        except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
            raise DatasetLoadError(f"Unable to read CSV dataset: {source}") from error
        return _build_recording(metadata, batch)


def _build_recording(metadata: dict[str, object], batch: SampleBatch) -> Recording:
    try:
        recording_id = UUID(str(metadata["recording_id"]))
        channel_names = tuple(str(name) for name in metadata["channel_names"])
        if metadata["channel_count"] != len(channel_names):
            raise DatasetLoadError("Metadata channel count does not match channel names")
        if metadata["sample_count"] != len(batch.sample_indices):
            raise DatasetLoadError("Metadata sample count does not match data")
        if tuple(batch.channel_names) != channel_names:
            raise DatasetLoadError("Data channel order does not match metadata")
        annotations = tuple(
            RecordingAnnotation(
                recording_id=recording_id,
                annotation_id=UUID(str(item["annotation_id"])),
                label=str(item["label"]),
                start_sample=int(item["start_sample"]),
                end_sample=int(item["end_sample"]),
                notes=str(item.get("notes", "")),
            )
            for item in metadata.get("annotations", [])
        )
        result = RecordingMetadata(
            recording_id=recording_id,
            label=str(metadata["label"]),
            start_timestamp=str(metadata["start_timestamp"]),
            end_timestamp=str(metadata["end_timestamp"]),
            duration_seconds=float(metadata["duration_seconds"]),
            sampling_rate=float(metadata["sampling_rate"]),
            channel_count=int(metadata["channel_count"]),
            channel_names=channel_names,
            device_name=str(metadata["device_name"]),
            device_serial=str(metadata["device_serial"]),
            data_file_path="",
            sample_count=int(metadata["sample_count"]),
            created_at=str(metadata["created_at"]),
        )
        return Recording(result, batch, annotations)
    except DatasetLoadError:
        raise
    except (KeyError, TypeError, ValueError) as error:
        raise DatasetLoadError("Exported dataset metadata is invalid") from error
