"""Load a Person 1 ``EegSource`` from the command line and bridge it into the hub. Owner: Person 5.

``oxford-backend serve --eeg-source package.module:factory`` imports ``package.module``, calls
``factory()`` with no arguments and expects an ``EegSource`` (see ``interface.py``). The source runs on
its own thread and publishes features/status into a bounded sink; the hub drains the sink on each tick
and delivers items to *live* sessions that enabled EEG. Nothing is fabricated here: if the source never
reports, the session shows EEG as unavailable.
"""

from __future__ import annotations

import importlib
import re
from collections.abc import Callable
from typing import Any

from ..contracts.payloads import EegFeatureWindow, EegStatus
from ..timing.clock import Clock
from .interface import EegSink, EegSource, ThreadSafeEegSink

_SPEC = re.compile(r"^(?P<module>[A-Za-z_][\w.]*):(?P<attr>[A-Za-z_][\w.]*)$")


class EegSourceLoadError(Exception):
    pass


def load_source_factory(spec: str) -> Callable[[], EegSource]:
    """Resolve ``module:attr`` to a zero-argument factory. Errors name the spec and the cause."""
    match = _SPEC.match(spec)
    if match is None:
        raise EegSourceLoadError(f"--eeg-source must look like 'package.module:factory', got {spec!r}")
    try:
        obj: Any = importlib.import_module(match["module"])
        for part in match["attr"].split("."):
            obj = getattr(obj, part)
    except (ImportError, AttributeError) as err:
        raise EegSourceLoadError(f"cannot load EEG source {spec!r}: {err}") from err
    if not callable(obj):
        raise EegSourceLoadError(f"{spec!r} is not callable")
    return obj  # type: ignore[no-any-return]


class LiveEegBridge:
    """Owns one started ``EegSource`` and its sink. ``poll`` is called from the hub loop."""

    def __init__(self, source: EegSource, clock: Clock, sink: ThreadSafeEegSink | None = None) -> None:
        self.source = source
        self._clock = clock
        self.sink = sink or ThreadSafeEegSink()
        self._started = False

    def start(self) -> None:
        if not self._started:
            self.source.start(self.sink_as_protocol(), self._clock)
            self._started = True

    def sink_as_protocol(self) -> EegSink:
        return self.sink

    def poll(self, now_backend_ms: float) -> list[EegFeatureWindow | EegStatus]:
        return self.sink.drain()

    def session_started(self) -> None:
        """Tell sources that opt in (``on_live_session_started``) that a live EEG session began."""
        notify = getattr(self.source, "on_live_session_started", None)
        if callable(notify):
            notify()

    def stop(self) -> None:
        if self._started:
            self._started = False
            self.source.stop()
