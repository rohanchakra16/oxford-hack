"""GUI-independent lifecycle management for raw EEG recordings."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from threading import Event, Lock, Thread
from typing import Any

import numpy as np

from eeg.acquisition.base_device import EEGDevice, SampleBatch
from eeg.processing.signal_preprocessor import EEGPreprocessor
from eeg.realtime.feature_extractor import EEGFeatureExtractor

from .recording_database import RecordingDatabase
from .recording_metadata import RecordingMetadata


class RecordingManagerError(RuntimeError):
    """Raised when a recording lifecycle operation cannot be completed."""


class RecordingState(str, Enum):
    """States exposed by :class:`RecordingManager`."""

    IDLE = "idle"
    RECORDING = "recording"
    REVIEW_PENDING = "review_pending"


@dataclass(frozen=True)
class RecordingStatus:
    """Snapshot of recording state safe to display in a GUI."""

    state: RecordingState
    label: str | None
    sample_count: int
    error: str | None = None
    saved_recording_id: str | None = None


class RecordingManager:
    """Collect raw device batches and require an explicit save or discard.

    Acquisition happens on a background thread so starting a recording does
    not synchronously wait for a device batch. The manager stores raw samples
    only; it performs no filtering, feature extraction, or attention scoring.
    """

    def __init__(
        self,
        device: EEGDevice,
        database: RecordingDatabase,
        *,
        batch_size: int = 25,
        feature_extractor: EEGFeatureExtractor | None = None,
        preprocessor: EEGPreprocessor | None = None,
    ) -> None:
        if batch_size <= 0:
            raise ValueError("batch_size must be positive")
        self._device = device
        self._database = database
        self._batch_size = batch_size
        self._state = RecordingState.IDLE
        self._label: str | None = None
        self._batches: list[SampleBatch] = []
        self._stop_event = Event()
        self._thread: Thread | None = None
        self._error: Exception | None = None
        self._saved_metadata: RecordingMetadata | None = None
        self._lock = Lock()
        self._feature_extractor = feature_extractor
        self._preprocessor = preprocessor

    def start_recording(self, label: str) -> None:
        """Validate ``label``, start device streaming, and return promptly."""
        if not isinstance(label, str) or not label.strip():
            raise ValueError("recording label must be a non-empty string")
        with self._lock:
            if self._state is not RecordingState.IDLE:
                raise RecordingManagerError(
                    "A recording must be saved or discarded before starting another"
                )
            self._label = label.strip()
            self._batches = []
            self._error = None
            self._saved_metadata = None
            self._stop_event.clear()
            try:
                self._device.start_streaming()
            except Exception:
                self._label = None
                raise
            self._state = RecordingState.RECORDING
            self._thread = Thread(target=self._collect, name="eeg-recording", daemon=True)
            self._thread.start()

    def stop_recording(self) -> None:
        """Stop acquisition and finalize a review-pending temporary recording."""
        with self._lock:
            if self._state is not RecordingState.RECORDING:
                raise RecordingManagerError("No recording is currently active")
            thread = self._thread
            self._stop_event.set()
        try:
            self._device.stop_streaming()
        except Exception as error:
            with self._lock:
                self._error = error
        if thread is not None:
            thread.join()
        with self._lock:
            self._thread = None
            self._state = RecordingState.REVIEW_PENDING
            if self._error is not None:
                raise RecordingManagerError("Acquisition failed during recording") from self._error

    def save_recording(self) -> RecordingMetadata:
        """Persist the raw temporary recording and return its database metadata."""
        with self._lock:
            self._require_review_pending()
            batch = self._combine_batches()
            label = self._label
        try:
            feature_frames = None
            if self._feature_extractor is not None:
                feature_batch = batch
                if self._preprocessor is not None:
                    feature_batch = self._preprocessor.process(batch)
                    feature_window = feature_batch.samples
                else:
                    feature_window = feature_batch.samples
                feature_frames = [
                    _json_safe(
                        self._feature_extractor.extract(
                            feature_window,
                            feature_batch.sampling_frequency_hz,
                            {"channel_names": feature_batch.channel_names},
                            timestamp=float(feature_batch.timestamps[-1]),
                        )
                    )
                ]
            metadata = self._database.create_recording(
                label or "",
                batch,
                device_name=str(self._device.get_device_info().get("device_type", "")),
                device_serial=str(self._device.get_device_info().get("serial", "")),
                feature_frames=feature_frames,
            )
        except Exception as error:
            raise RecordingManagerError(
                "Recording could not be saved; temporary data remains available"
            ) from error
        with self._lock:
            self._saved_metadata = metadata
            self._batches.clear()
            self._label = None
            self._state = RecordingState.IDLE
        return metadata

    def discard_recording(self) -> None:
        """Release the temporary recording without creating a database entry."""
        with self._lock:
            self._require_review_pending()
            self._batches.clear()
            self._label = None
            self._error = None
            self._state = RecordingState.IDLE

    def get_recording_status(self) -> RecordingStatus:
        """Return the current lifecycle state and collected sample count."""
        with self._lock:
            return RecordingStatus(
                state=self._state,
                label=self._label,
                sample_count=sum(len(batch.sample_indices) for batch in self._batches),
                error=str(self._error) if self._error else None,
                saved_recording_id=(
                    str(self._saved_metadata.recording_id)
                    if self._saved_metadata is not None
                    else None
                ),
            )

    def _collect(self) -> None:
        while not self._stop_event.is_set():
            try:
                batch = self._device.get_samples(self._batch_size)
            except Exception as error:
                if not self._stop_event.is_set():
                    with self._lock:
                        self._error = error
                return
            with self._lock:
                if self._state is not RecordingState.RECORDING:
                    return
                self._batches.append(batch)

    def _combine_batches(self) -> SampleBatch:
        if not self._batches:
            raise RecordingManagerError("Cannot save an empty recording")
        first = self._batches[0]
        if any(
            batch.channel_names != first.channel_names
            or batch.sampling_frequency_hz != first.sampling_frequency_hz
            or batch.signal_units != first.signal_units
            for batch in self._batches[1:]
        ):
            raise RecordingManagerError("Recording batches have inconsistent metadata")
        return SampleBatch(
            samples=np.concatenate([batch.samples for batch in self._batches]),
            timestamps=np.concatenate([batch.timestamps for batch in self._batches]),
            sample_indices=np.concatenate([batch.sample_indices for batch in self._batches]),
            channel_names=first.channel_names,
            sampling_frequency_hz=first.sampling_frequency_hz,
            signal_units=first.signal_units,
        )

    def _require_review_pending(self) -> None:
        if self._state is not RecordingState.REVIEW_PENDING:
            raise RecordingManagerError(
                "Recording must be stopped before it can be saved or discarded"
            )


def _json_safe(value: Any) -> Any:
    """Convert NumPy scalars and arrays in feature output to JSON values."""
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if isinstance(value, np.ndarray):
        return [_json_safe(item) for item in value.tolist()]
    if isinstance(value, np.generic):
        return value.item()
    return value
