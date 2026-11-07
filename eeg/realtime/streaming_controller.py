"""Producer-consumer real-time EEG processing pipeline."""

from __future__ import annotations

import logging
import queue
import time
from dataclasses import dataclass
from threading import Event, Lock, Thread
from typing import Any, Callable

import numpy as np

from eeg.acquisition.base_device import EEGDevice, SampleBatch
from eeg.processing.eeg_buffer import EEGBuffer
from eeg.processing.signal_preprocessor import EEGPreprocessor, PreprocessedBatch

from .attention_classifier import AttentionClassifier
from .feature_extractor import EEGFeatureExtractor

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class StreamingStats:
    """Observable performance and queue metrics."""

    acquisition_latency_ms: float = 0.0
    preprocessing_latency_ms: float = 0.0
    feature_latency_ms: float = 0.0
    classification_latency_ms: float = 0.0
    total_processing_latency_ms: float = 0.0
    queue_depth: int = 0
    missed_update_deadlines: int = 0
    acquisition_overflow: bool = False


class StreamingController:
    """Stream, preprocess, window, extract, and classify EEG continuously.

    The acquisition thread only talks to the device and bounded acquisition
    queue. Processing runs independently and emits complete frames through the
    callback and optional bounded output queue. Raw sample indices and
    timestamps are retained in every analysis window.
    """

    def __init__(
        self,
        device: EEGDevice,
        preprocessor: EEGPreprocessor,
        feature_extractor: EEGFeatureExtractor,
        classifier: AttentionClassifier,
        *,
        window_duration_seconds: float = 2.0,
        window_overlap: float = 0.75,
        update_interval_seconds: float = 0.5,
        queue_capacity: int = 32,
        output_capacity: int = 32,
        batch_size: int | None = None,
        on_frame: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        if not 0 <= window_overlap < 1:
            raise ValueError("window_overlap must be in [0, 1)")
        if window_duration_seconds <= 0 or update_interval_seconds <= 0:
            raise ValueError("window and update durations must be positive")
        if queue_capacity <= 0 or output_capacity <= 0:
            raise ValueError("queue capacities must be positive")
        self.device = device
        self.preprocessor = preprocessor
        self.feature_extractor = feature_extractor
        self.classifier = classifier
        self.window_duration_seconds = window_duration_seconds
        self.window_overlap = window_overlap
        self.update_interval_seconds = update_interval_seconds
        self.batch_size = batch_size
        self.on_frame = on_frame
        self._input_queue: queue.Queue[SampleBatch] = queue.Queue(queue_capacity)
        self._output_queue: queue.Queue[dict[str, Any]] = queue.Queue(output_capacity)
        self._stop = Event()
        self._threads: list[Thread] = []
        self._error: Exception | None = None
        self._lock = Lock()
        self._stats = StreamingStats()
        self._frame_index = 0
        self._last_processed_index: int | None = None
        self._buffer: EEGBuffer | None = None
        self._window_samples = 0
        self._update_samples = 0

    def start(self) -> None:
        """Start device streaming and both pipeline stages."""
        if self._threads:
            raise RuntimeError("streaming controller is already running")
        info = self.device.get_device_info()
        frequency = float(info.get("sampling_frequency_hz", 0.0))
        if frequency <= 0:
            raise ValueError("device did not provide a positive sampling frequency")
        self._window_samples = max(1, int(np.ceil(self.window_duration_seconds * frequency)))
        self._update_samples = max(1, int(np.ceil(self.update_interval_seconds * frequency)))
        self._buffer = EEGBuffer(
            self.window_duration_seconds + self.update_interval_seconds + 1.0,
            frequency,
        )
        self.preprocessor.reset()
        self._stop.clear()
        self._error = None
        self._frame_index = 0
        self._last_processed_index = None
        self.device.start_streaming()
        producer = Thread(target=self._acquire, name="eeg-stream-acquire", daemon=True)
        processor = Thread(target=self._process, name="eeg-stream-process", daemon=True)
        self._threads = [producer, processor]
        for thread in self._threads:
            thread.start()

    def stop(self, timeout: float = 2.0) -> None:
        """Stop acquisition and join pipeline threads."""
        self._stop.set()
        try:
            self.device.stop_streaming()
        except Exception as error:
            self._set_error(error)
        for thread in self._threads:
            thread.join(timeout)
        self._threads.clear()

    def get_frame(self, timeout: float | None = None) -> dict[str, Any]:
        """Return the next emitted frame, or raise queue.Empty."""
        return self._output_queue.get(timeout=timeout)

    def get_stats(self) -> StreamingStats:
        with self._lock:
            status = self._buffer.status() if self._buffer is not None else None
            return StreamingStats(
                **{
                    **self._stats.__dict__,
                    "queue_depth": self._input_queue.qsize(),
                    "acquisition_overflow": bool(status and status.overflowed),
                }
            )

    @property
    def error(self) -> Exception | None:
        return self._error

    def _acquire(self) -> None:
        while not self._stop.is_set():
            started = time.perf_counter()
            try:
                batch = self.device.get_samples(self.batch_size or self._update_samples)
                self._input_queue.put(batch, timeout=0.1)
            except queue.Full:
                self._set_error(RuntimeError("Acquisition queue overflow; streaming stopped"))
                self._stop.set()
                return
            except Exception as error:
                if not self._stop.is_set():
                    self._set_error(error)
                return
            self._update_stat("acquisition_latency_ms", (time.perf_counter() - started) * 1000)

    def _process(self) -> None:
        while not self._stop.is_set() or not self._input_queue.empty():
            try:
                batch = self._input_queue.get(timeout=0.05)
            except queue.Empty:
                continue
            try:
                self._process_batch(batch)
            except Exception as error:
                self._set_error(error)

    def _process_batch(self, batch: SampleBatch) -> None:
        assert self._buffer is not None
        started = time.perf_counter()
        processed = self.preprocessor.process(batch)
        self._update_stat("preprocessing_latency_ms", (time.perf_counter() - started) * 1000)
        processed_batch = SampleBatch(
            samples=processed.samples,
            timestamps=processed.timestamps,
            sample_indices=processed.sample_indices,
            channel_names=batch.channel_names,
            sampling_frequency_hz=batch.sampling_frequency_hz,
            signal_units=batch.signal_units,
        )
        self._buffer.append(processed_batch)
        latest = int(batch.sample_indices[-1])
        if latest < self._window_samples - 1:
            return
        if self._last_processed_index is not None and latest - self._last_processed_index < self._update_samples:
            return
        window = self._buffer.get_recent(self.window_duration_seconds)
        if len(window.sample_indices) < self._window_samples:
            return
        self._last_processed_index = latest
        processing_started = time.perf_counter()
        started = processing_started
        extracted = self.feature_extractor.extract(
            window.samples,
            window.sampling_frequency_hz,
            {"channel_names": window.channel_names, "signal_units": window.signal_units},
            timestamp=float(window.timestamps[-1]),
        )
        self._update_stat("feature_latency_ms", (time.perf_counter() - started) * 1000)
        extracted["frame_index"] = self._frame_index
        started = time.perf_counter()
        prediction = self.classifier.predict(extracted)
        self._update_stat("classification_latency_ms", (time.perf_counter() - started) * 1000)
        frame = {
            "frame_index": self._frame_index,
            "window_start_timestamp": float(window.timestamps[0]),
            "window_end_timestamp": float(window.timestamps[-1]),
            "processing_timestamp": time.time(),
            "sample_indices": (int(window.sample_indices[0]), int(window.sample_indices[-1])),
            "preprocessed_metadata": {
                "sampling_frequency_hz": window.sampling_frequency_hz,
                "channel_names": window.channel_names,
                "signal_units": window.signal_units,
                "quality": processed.quality,
            },
            "features": extracted["features"],
            "execution_times_ms": extracted["execution_times_ms"],
            "prediction": prediction,
            "attention_score": prediction.get("attention_score"),
            "prediction_valid": prediction.get("valid", False),
        }
        self._frame_index += 1
        self._update_stat(
            "total_processing_latency_ms",
            (time.perf_counter() - processing_started) * 1000,
        )
        try:
            self._output_queue.put_nowait(frame)
        except queue.Full:
            self._update_stat("missed_update_deadlines", 1)
            logger.warning("Streaming output queue full; frame was not retained")
        if self.on_frame is not None:
            self.on_frame(frame)

    def _update_stat(self, name: str, value: float | int) -> None:
        with self._lock:
            values = self._stats.__dict__.copy()
            values[name] = value
            self._stats = StreamingStats(**values)

    def _set_error(self, error: Exception) -> None:
        with self._lock:
            self._error = error
