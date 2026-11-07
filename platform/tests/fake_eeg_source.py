"""A stand-in for Person 1's EegSource used only by tests (no device, no data)."""

from __future__ import annotations

import threading

from oxford_hack.contracts.payloads import EegDeviceInfo, EegStatus, Provenance
from oxford_hack.eeg.interface import EegSink
from oxford_hack.timing.clock import Clock


class FakeSource:
    """Publishes a status every 20 ms from its own thread, like a real acquisition loop."""

    stream_id = "fake-eeg"

    def __init__(self) -> None:
        self.started = False
        self.stopped = False
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def _status(self, clock: Clock) -> EegStatus:
        return EegStatus(
            stream_id=self.stream_id,
            state="ok",
            flags=["units_unverified"],
            device=EegDeviceInfo(
                model="fake (test)", confirmed=False, sample_rate_hz=None, channel_names=None, units=None
            ),
            dropped_packets=0,
            t_backend_ms=clock.now_ms(),
            provenance=Provenance(run_kind="live", producer="fake-eeg-test", producer_version="0"),
        )

    def start(self, sink: EegSink, clock: Clock) -> None:
        self.started = True

        def run() -> None:
            while not self._stop.wait(0.02):
                sink.publish_status(self._status(clock))

        self._thread = threading.Thread(target=run, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self.stopped = True
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1)


INSTANCES: list[FakeSource] = []


def make_source() -> FakeSource:
    INSTANCES.append(FakeSource())
    return INSTANCES[-1]


class DeclaredSource(FakeSource):
    """A source that says it is not a headset (as the rehearsal source does)."""

    session_starts = 0

    def on_live_session_started(self) -> None:
        DeclaredSource.session_starts += 1

    declared_device = EegDeviceInfo(
        model="declared test source (not a headset)",
        confirmed=False,
        sample_rate_hz=None,
        channel_names=None,
        units=None,
    )


def make_declared_source() -> DeclaredSource:
    source = DeclaredSource()
    INSTANCES.append(source)
    return source
