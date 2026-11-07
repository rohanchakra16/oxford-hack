"""Backend clock. All ``...BackendMs`` values come from one Clock per backend process."""

from __future__ import annotations

import time
from typing import Protocol


class Clock(Protocol):
    def now_ms(self) -> float: ...


class MonotonicClock:
    """Real backend clock: monotonic milliseconds (never jumps with wall-clock changes)."""

    def now_ms(self) -> float:
        return time.monotonic_ns() / 1e6


class ManualClock:
    """Deterministic clock for tests, replay and harnesses. Time moves only when told to."""

    def __init__(self, start_ms: float = 1_000.0) -> None:
        self._now = start_ms

    def now_ms(self) -> float:
        return self._now

    def advance(self, ms: float) -> float:
        if ms < 0:
            raise ValueError("ManualClock cannot go backwards")
        self._now += ms
        return self._now

    def set(self, ms: float) -> None:
        if ms < self._now:
            raise ValueError("ManualClock cannot go backwards")
        self._now = ms
