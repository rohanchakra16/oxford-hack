"""Export raw recordings without applying feature extraction or preprocessing."""

from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Iterable
from uuid import UUID

import numpy as np

from .recording_database import RecordingDatabase
from .recording_metadata import Recording


class DatasetExportError(RuntimeError):
    """Raised when a recording cannot be exported."""


class DatasetExporter:
    """Export recordings from :class:`RecordingDatabase` in portable formats."""

    def __init__(self, database: RecordingDatabase) -> None:
        self.database = database

    def export_recording(
        self, recording_id: UUID | str, destination: str | Path, format: str | None = None
    ) -> Path:
        """Export one recording and return the created file path."""
        recording = self.database.get_recording(recording_id)
        if recording is None:
            raise DatasetExportError(f"Recording not found: {recording_id}")
        path = Path(destination)
        selected_format = (format or path.suffix.lstrip(".")).lower()
        if selected_format not in {"npz", "csv", "json"}:
            raise ValueError("format must be npz, csv, or json")
        path.parent.mkdir(parents=True, exist_ok=True)
        if selected_format == "npz":
            self._write_npz(recording, path)
        elif selected_format == "csv":
            self._write_csv(recording, path)
            self._write_json(recording, path.with_suffix(".json"))
        else:
            self._write_json(recording, path)
        return path

    def export_all(self, destination: str | Path, format: str = "npz") -> list[Path]:
        """Export every recording using deterministic filenames."""
        return self._export_many(self.database.list_recordings(), destination, format)

    def export_by_label(
        self, label: str, destination: str | Path, format: str = "npz"
    ) -> list[Path]:
        """Export all recordings with an exact matching label."""
        return self._export_many(
            self.database.list_recordings_by_label(label), destination, format
        )

    def export_selected(
        self, recording_ids: Iterable[UUID | str], destination: str | Path, format: str = "npz"
    ) -> list[Path]:
        """Export the selected recording IDs, preserving the requested order."""
        paths: list[Path] = []
        output = Path(destination)
        for recording_id in recording_ids:
            path = output / f"{recording_id}.{format.lower()}" if output.suffix == "" else output
            paths.append(self.export_recording(recording_id, path, format))
        return paths

    def _export_many(self, metadata, destination: str | Path, format: str) -> list[Path]:
        output = Path(destination)
        output.mkdir(parents=True, exist_ok=True)
        suffix = format.lower().lstrip(".")
        return [
            self.export_recording(
                item.recording_id, output / f"{item.recording_id}.{suffix}", suffix
            )
            for item in metadata
        ]

    @staticmethod
    def _write_npz(recording: Recording, path: Path) -> None:
        batch = recording.sample_batch
        np.savez_compressed(
            path,
            samples=batch.samples,
            timestamps=batch.timestamps,
            sample_indices=batch.sample_indices,
            channel_names=np.asarray(batch.channel_names),
            sampling_frequency_hz=np.asarray(batch.sampling_frequency_hz),
            signal_units=np.asarray(batch.signal_units),
            metadata_json=np.asarray(json.dumps(_metadata_dict(recording))),
        )

    @staticmethod
    def _write_csv(recording: Recording, path: Path) -> None:
        batch = recording.sample_batch
        with path.open("w", newline="", encoding="utf-8") as file:
            writer = csv.writer(file)
            writer.writerow(["timestamp", "sample_index", *batch.channel_names])
            writer.writerows(
                [timestamp, index, *samples]
                for timestamp, index, samples in zip(
                    batch.timestamps, batch.sample_indices, batch.samples
                )
            )

    @staticmethod
    def _write_json(recording: Recording, path: Path) -> None:
        path.write_text(json.dumps(_metadata_dict(recording), indent=2), encoding="utf-8")


def _metadata_dict(recording: Recording) -> dict[str, object]:
    metadata = recording.metadata
    return {
        "recording_id": str(metadata.recording_id),
        "label": metadata.label,
        "start_timestamp": metadata.start_timestamp,
        "end_timestamp": metadata.end_timestamp,
        "duration_seconds": metadata.duration_seconds,
        "sampling_rate": metadata.sampling_rate,
        "channel_count": metadata.channel_count,
        "channel_names": list(metadata.channel_names),
        "device_name": metadata.device_name,
        "device_serial": metadata.device_serial,
        "sample_count": metadata.sample_count,
        "created_at": metadata.created_at,
        "feature_file_path": metadata.feature_file_path,
        "signal_units": recording.sample_batch.signal_units,
        "annotations": [
            {
                "annotation_id": str(annotation.annotation_id),
                "recording_id": str(annotation.recording_id),
                "label": annotation.label,
                "start_sample": annotation.start_sample,
                "end_sample": annotation.end_sample,
                "notes": annotation.notes,
            }
            for annotation in recording.annotations
        ],
    }
