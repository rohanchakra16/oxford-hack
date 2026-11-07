"""Interface between EEG acquisition/processing (Person 1) and the hub (Person 5).

Person 1's adapter runs wherever the device SDK/LSL needs it (usually its own thread) and
publishes *features and status only* through an EegSink. Raw samples stay inside the adapter
(and an optional, explicitly opted-in local raw logger owned by Person 1).

Before publishing, convert device/LSL timestamps to backend time with a DeviceClockMapper
(``oxford_hack.timing.device_clock``) and fill ``EegFeatureWindow.clock_correction``.
Device details (model, channels, sample rate, units) come from the device, never hard-coded:
leave them null / ``confirmed=False`` until verified.
"""

from __future__ import annotations

import queue
import threading
from typing import Protocol

from ..contracts.payloads import EegFeatureWindow, EegStatus
from ..timing.clock import Clock


class EegSink(Protocol):
    def publish_window(self, window: EegFeatureWindow) -> None: ...
    def publish_status(self, status: EegStatus) -> None: ...


class EegSource(Protocol):
    """Long-running live source. ``start`` must return promptly (spawn your own thread)."""

    stream_id: str

    def start(self, sink: EegSink, clock: Clock) -> None: ...
    def stop(self) -> None: ...


class ThreadSafeEegSink:
    """Bounded hand-off from an acquisition thread to the hub loop.

    When full, the OLDEST item is dropped and counted: stale features are worth less than new
    ones, and the hub must never block the acquisition thread.
    """

    def __init__(self, maxsize: int = 256) -> None:
        self._queue: queue.Queue[EegFeatureWindow | EegStatus] = queue.Queue(maxsize=maxsize)
        self._lock = threading.Lock()
        self.dropped = 0

    def _put(self, item: EegFeatureWindow | EegStatus) -> None:
        with self._lock:
            while True:
                try:
                    self._queue.put_nowait(item)
                    return
                except queue.Full:
                    try:
                        self._queue.get_nowait()
                        self.dropped += 1
                    except queue.Empty:
                        pass

    def publish_window(self, window: EegFeatureWindow) -> None:
        self._put(window)

    def publish_status(self, status: EegStatus) -> None:
        self._put(status)

    def drain(self, limit: int = 1000) -> list[EegFeatureWindow | EegStatus]:
        items: list[EegFeatureWindow | EegStatus] = []
        while len(items) < limit:
            try:
                items.append(self._queue.get_nowait())
            except queue.Empty:
                break
        return items
