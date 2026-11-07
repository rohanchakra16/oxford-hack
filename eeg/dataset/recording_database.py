"""SQLite persistence for raw EEG recordings stored as compressed NPZ files."""

from __future__ import annotations

import json
import os
import sqlite3
import tempfile
from threading import RLock
from pathlib import Path
from typing import Iterable
from uuid import UUID, uuid4

import numpy as np

from eeg.acquisition.base_device import SampleBatch

from .recording_metadata import (
    Recording,
    RecordingAnnotation,
    RecordingMetadata,
    utc_now_iso,
)


class RecordingDatabase:
    """Persist recording metadata in SQLite and raw arrays in compressed NPZ files.

    Raw arrays are never replaced with preprocessed arrays. If processed data is
    added later, it must use a separate file and an explicit schema field.
    """

    def __init__(self, database_path: str | Path, data_directory: str | Path | None = None):
        self.database_path = Path(database_path)
        self.data_directory = Path(data_directory or self.database_path.parent / "recordings")
        self.data_directory.mkdir(parents=True, exist_ok=True)
        # GUI persistence operations run in Qt worker threads. A re-entrant
        # lock keeps this connection's transactions serialized across those
        # threads while still allowing nested read operations.
        self._lock = RLock()
        self._connection = sqlite3.connect(self.database_path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA foreign_keys = ON")
        self._create_schema()

    def close(self) -> None:
        """Close the SQLite connection."""
        with self._lock:
            self._connection.close()

    def create_recording(
        self,
        label: str,
        sample_batch: SampleBatch,
        *,
        device_name: str = "",
        device_serial: str = "",
        start_timestamp: str | None = None,
        end_timestamp: str | None = None,
        recording_id: UUID | None = None,
        feature_frames: list[dict[str, object]] | None = None,
    ) -> RecordingMetadata:
        """Atomically store a raw batch and its metadata."""
        with self._lock:
            recording_id = recording_id or uuid4()
            path = self.data_directory / f"{recording_id}.npz"
            start = start_timestamp or str(float(sample_batch.timestamps[0]))
            end = end_timestamp or str(float(sample_batch.timestamps[-1]))
            duration = (
                float(sample_batch.timestamps[-1] - sample_batch.timestamps[0])
                if len(sample_batch.timestamps) > 1
                else 0.0
            )
            metadata = RecordingMetadata(
                recording_id=recording_id,
                label=label,
                start_timestamp=start,
                end_timestamp=end,
                duration_seconds=duration,
                sampling_rate=sample_batch.sampling_frequency_hz,
                channel_count=sample_batch.samples.shape[1],
                channel_names=sample_batch.channel_names,
                device_name=device_name,
                device_serial=device_serial,
                data_file_path=str(path),
                sample_count=sample_batch.samples.shape[0],
            )
            feature_path = self.data_directory / f"{recording_id}.features.json"
            if feature_frames is not None:
                metadata = RecordingMetadata(
                    **{**metadata.__dict__, "feature_file_path": str(feature_path)}
                )
            self._write_npz_atomically(path, sample_batch)
            if feature_frames is not None:
                self._write_features_atomically(feature_path, feature_frames)
            try:
                with self._connection:
                    self._connection.execute(
                        """INSERT INTO recordings
                        (recording_id, label, start_timestamp, end_timestamp,
                         duration_seconds, sampling_rate, channel_count,
                         channel_names, device_name, device_serial, data_file_path,
                         sample_count, created_at, feature_file_path)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        self._metadata_values(metadata),
                    )
            except Exception:
                path.unlink(missing_ok=True)
                feature_path.unlink(missing_ok=True)
                raise
            return metadata

    def get_recording(self, recording_id: UUID | str) -> Recording | None:
        """Load metadata, raw NPZ arrays, and annotations for one recording."""
        row = self._connection.execute(
            "SELECT * FROM recordings WHERE recording_id = ?", (str(recording_id),)
        ).fetchone()
        if row is None:
            return None
        metadata = self._row_to_metadata(row)
        try:
            sample_batch = self._read_npz(Path(metadata.data_file_path))
        except (OSError, KeyError, ValueError) as error:
            raise RuntimeError(f"Unable to read recording data: {metadata.data_file_path}") from error
        annotations = tuple(self._annotations_for(metadata.recording_id))
        return Recording(metadata, sample_batch, annotations)

    def list_recordings(self) -> list[RecordingMetadata]:
        """Return recording metadata ordered by creation time."""
        with self._lock:
            rows = self._connection.execute(
                "SELECT * FROM recordings ORDER BY created_at, recording_id"
            ).fetchall()
            return [self._row_to_metadata(row) for row in rows]

    def list_recordings_by_label(self, label: str) -> list[RecordingMetadata]:
        """Return metadata whose label exactly matches ``label``."""
        rows = self._connection.execute(
            "SELECT * FROM recordings WHERE label = ? ORDER BY created_at, recording_id",
            (label,),
        ).fetchall()
        return [self._row_to_metadata(row) for row in rows]

    def load_feature_frames(self, recording_id: UUID | str) -> list[dict[str, object]]:
        """Load separately stored feature frames for model-training workflows."""
        recording = self.get_recording(recording_id)
        if recording is None:
            raise KeyError(f"Recording not found: {recording_id}")
        if not recording.metadata.feature_file_path:
            return []
        try:
            with Path(recording.metadata.feature_file_path).open(
                encoding="utf-8"
            ) as feature_file:
                frames = json.load(feature_file)
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError(
                f"Unable to read feature data: {recording.metadata.feature_file_path}"
            ) from error
        if not isinstance(frames, list) or not all(isinstance(frame, dict) for frame in frames):
            raise RuntimeError("Feature data must contain a list of frames")
        return frames

    def update_recording(self, metadata: RecordingMetadata) -> RecordingMetadata:
        """Update database metadata without changing the raw NPZ file."""
        values = self._metadata_values(metadata)[1:] + (str(metadata.recording_id),)
        with self._connection:
            cursor = self._connection.execute(
                """UPDATE recordings SET label=?, start_timestamp=?, end_timestamp=?,
                duration_seconds=?, sampling_rate=?, channel_count=?, channel_names=?,
                device_name=?, device_serial=?, data_file_path=?, sample_count=?,
                created_at=?, feature_file_path=? WHERE recording_id=?""",
                values,
            )
        if cursor.rowcount != 1:
            raise KeyError(f"Recording not found: {metadata.recording_id}")
        return metadata

    def delete_recording(self, recording_id: UUID | str) -> bool:
        """Delete metadata and its NPZ file, returning whether it existed."""
        recording = self.get_recording(recording_id)
        if recording is None:
            return False
        annotation_rows = tuple(recording.annotations)
        try:
            with self._connection:
                self._connection.execute(
                    "DELETE FROM recording_annotations WHERE recording_id = ?",
                    (str(recording.metadata.recording_id),),
                )
                self._connection.execute(
                    "DELETE FROM recordings WHERE recording_id = ?",
                    (str(recording.metadata.recording_id),),
                )
                Path(recording.metadata.data_file_path).unlink(missing_ok=True)
                if recording.metadata.feature_file_path:
                    Path(recording.metadata.feature_file_path).unlink(missing_ok=True)
        except Exception:
            with self._connection:
                self._connection.execute(
                    "INSERT OR REPLACE INTO recordings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    self._metadata_values(recording.metadata),
                )
                for annotation in annotation_rows:
                    self._connection.execute(
                        """INSERT OR REPLACE INTO recording_annotations
                        (annotation_id, recording_id, label, start_sample, end_sample, notes)
                        VALUES (?, ?, ?, ?, ?, ?)""",
                        (str(annotation.annotation_id), str(annotation.recording_id),
                         annotation.label, annotation.start_sample, annotation.end_sample,
                         annotation.notes),
                    )
            raise
        return True

    def add_annotation(self, annotation: RecordingAnnotation) -> RecordingAnnotation:
        """Store an annotation linked to an existing recording."""
        if self.get_recording(annotation.recording_id) is None:
            raise KeyError(f"Recording not found: {annotation.recording_id}")
        with self._connection:
            self._connection.execute(
                """INSERT INTO recording_annotations
                (annotation_id, recording_id, label, start_sample, end_sample, notes)
                VALUES (?, ?, ?, ?, ?, ?)""",
                (str(annotation.annotation_id), str(annotation.recording_id),
                 annotation.label, annotation.start_sample, annotation.end_sample,
                 annotation.notes),
            )
        return annotation

    def _create_schema(self) -> None:
        self._connection.executescript(
            """CREATE TABLE IF NOT EXISTS recordings (
                recording_id TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                start_timestamp TEXT NOT NULL,
                end_timestamp TEXT NOT NULL,
                duration_seconds REAL NOT NULL,
                sampling_rate REAL NOT NULL,
                channel_count INTEGER NOT NULL,
                channel_names TEXT NOT NULL,
                device_name TEXT NOT NULL,
                device_serial TEXT NOT NULL,
                data_file_path TEXT NOT NULL UNIQUE,
                sample_count INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                feature_file_path TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS recording_annotations (
                annotation_id TEXT PRIMARY KEY,
                recording_id TEXT NOT NULL REFERENCES recordings(recording_id)
                    ON DELETE CASCADE,
                label TEXT NOT NULL,
                start_sample INTEGER NOT NULL,
                end_sample INTEGER NOT NULL,
                notes TEXT NOT NULL
            );"""
        )
        columns = {
            row["name"]
            for row in self._connection.execute("PRAGMA table_info(recordings)")
        }
        if "feature_file_path" not in columns:
            self._connection.execute(
                "ALTER TABLE recordings ADD COLUMN feature_file_path TEXT NOT NULL DEFAULT ''"
            )
        self._connection.commit()

    @staticmethod
    def _metadata_values(metadata: RecordingMetadata) -> tuple[object, ...]:
        return (
            str(metadata.recording_id), metadata.label, metadata.start_timestamp,
            metadata.end_timestamp, metadata.duration_seconds, metadata.sampling_rate,
            metadata.channel_count, json.dumps(metadata.channel_names),
            metadata.device_name, metadata.device_serial, metadata.data_file_path,
            metadata.sample_count, metadata.created_at, metadata.feature_file_path,
        )

    @staticmethod
    def _write_npz_atomically(path: Path, batch: SampleBatch) -> None:
        with tempfile.NamedTemporaryFile(
            dir=path.parent, prefix=f".{path.stem}.", suffix=".tmp", delete=False
        ) as temporary:
            temporary_path = Path(temporary.name)
            np.savez_compressed(
                temporary,
                samples=batch.samples,
                timestamps=batch.timestamps,
                sample_indices=batch.sample_indices,
                channel_names=np.asarray(batch.channel_names),
                sampling_frequency_hz=np.asarray(batch.sampling_frequency_hz),
                signal_units=np.asarray(batch.signal_units),
            )
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_path, path)

    @staticmethod
    def _read_npz(path: Path) -> SampleBatch:
        with np.load(path, allow_pickle=False) as data:
            return SampleBatch(
                samples=np.asarray(data["samples"], dtype=np.float64),
                timestamps=np.asarray(data["timestamps"], dtype=np.float64),
                sample_indices=np.asarray(data["sample_indices"], dtype=np.int64),
                channel_names=tuple(str(value) for value in data["channel_names"].tolist()),
                sampling_frequency_hz=float(data["sampling_frequency_hz"]),
                signal_units=str(data["signal_units"].item()),
            )

    @staticmethod
    def _write_features_atomically(path: Path, frames: list[dict[str, object]]) -> None:
        with tempfile.NamedTemporaryFile(
            dir=path.parent, prefix=f".{path.stem}.", suffix=".tmp", mode="w",
            encoding="utf-8", delete=False
        ) as temporary:
            temporary_path = Path(temporary.name)
            json.dump(frames, temporary, indent=2)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_path, path)

    def _row_to_metadata(self, row: sqlite3.Row) -> RecordingMetadata:
        return RecordingMetadata(
            recording_id=UUID(row["recording_id"]),
            label=row["label"],
            start_timestamp=row["start_timestamp"],
            end_timestamp=row["end_timestamp"],
            duration_seconds=row["duration_seconds"],
            sampling_rate=row["sampling_rate"],
            channel_count=row["channel_count"],
            channel_names=tuple(json.loads(row["channel_names"])),
            device_name=row["device_name"],
            device_serial=row["device_serial"],
            data_file_path=row["data_file_path"],
            sample_count=row["sample_count"],
            created_at=row["created_at"],
            feature_file_path=row["feature_file_path"],
        )

    def _annotations_for(self, recording_id: UUID) -> Iterable[RecordingAnnotation]:
        rows = self._connection.execute(
            "SELECT * FROM recording_annotations WHERE recording_id = ? ORDER BY start_sample",
            (str(recording_id),),
        ).fetchall()
        return (
            RecordingAnnotation(
                annotation_id=UUID(row["annotation_id"]),
                recording_id=recording_id,
                label=row["label"],
                start_sample=row["start_sample"],
                end_sample=row["end_sample"],
                notes=row["notes"],
            )
            for row in rows
        )
