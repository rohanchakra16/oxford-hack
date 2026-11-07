"""Data models for persistent EEG recordings and sample annotations."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from uuid import UUID, uuid4

from eeg.acquisition.base_device import SampleBatch


def utc_now_iso() -> str:
    """Return a timezone-aware UTC timestamp suitable for SQLite text storage."""
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class RecordingMetadata:
    """Database metadata describing one raw EEG recording."""

    label: str
    start_timestamp: str
    end_timestamp: str
    duration_seconds: float
    sampling_rate: float
    channel_count: int
    channel_names: tuple[str, ...]
    device_name: str
    device_serial: str
    data_file_path: str
    sample_count: int
    created_at: str = field(default_factory=utc_now_iso)
    recording_id: UUID = field(default_factory=uuid4)
    feature_file_path: str = ""

    def __post_init__(self) -> None:
        """Validate metadata before it reaches the database."""
        if not self.label.strip():
            raise ValueError("label must not be empty")
        if self.duration_seconds < 0 or self.sampling_rate <= 0:
            raise ValueError("duration_seconds must be non-negative and sampling_rate positive")
        if self.channel_count <= 0 or len(self.channel_names) != self.channel_count:
            raise ValueError("channel_count must match channel_names")
        if self.sample_count < 0:
            raise ValueError("sample_count must be non-negative")


@dataclass(frozen=True)
class RecordingAnnotation:
    """A labelled interval expressed in global sample indices."""

    recording_id: UUID
    label: str
    start_sample: int
    end_sample: int
    notes: str = ""
    annotation_id: UUID = field(default_factory=uuid4)

    def __post_init__(self) -> None:
        if not self.label.strip():
            raise ValueError("annotation label must not be empty")
        if self.start_sample < 0 or self.end_sample < self.start_sample:
            raise ValueError("annotation sample range is invalid")


@dataclass(frozen=True)
class Recording:
    """A recording's metadata, raw samples, and annotations."""

    metadata: RecordingMetadata
    sample_batch: SampleBatch
    annotations: tuple[RecordingAnnotation, ...] = ()
