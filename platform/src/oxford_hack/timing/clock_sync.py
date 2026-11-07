"""Browser <-> backend clock synchronisation (NTP-style, backend-initiated).

The backend sends ClockPing(t1). The browser answers ClockPong(t1, t2=recv, t3=send).
The backend receives it at t4. For each exchange:

    offset = ((t2 - t1) + (t3 - t4)) / 2      # browser minus backend
    rtt    = (t4 - t1) - (t3 - t2)

The estimate uses the minimum-RTT sample among recent ones (least affected by queueing jitter).
Uncertainty = rtt/2 (worst-case asymmetry) + timer resolution + drift since that sample.
See docs/TIMING.md.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass

from ..contracts.payloads import ClockState


@dataclass(frozen=True)
class ClockSample:
    t1_backend_send_ms: float
    t2_browser_recv_ms: float
    t3_browser_send_ms: float
    t4_backend_recv_ms: float

    @property
    def offset_ms(self) -> float:
        return (
            (self.t2_browser_recv_ms - self.t1_backend_send_ms)
            + (self.t3_browser_send_ms - self.t4_backend_recv_ms)
        ) / 2

    @property
    def rtt_ms(self) -> float:
        return (self.t4_backend_recv_ms - self.t1_backend_send_ms) - (
            self.t3_browser_send_ms - self.t2_browser_recv_ms
        )


@dataclass(frozen=True)
class ClockEstimate:
    offset_browser_minus_backend_ms: float
    uncertainty_ms: float
    best_rtt_ms: float
    sample_count: int
    state: ClockState

    def browser_to_backend(self, t_browser_ms: float) -> float:
        return t_browser_ms - self.offset_browser_minus_backend_ms

    def backend_to_browser(self, t_backend_ms: float) -> float:
        return t_backend_ms + self.offset_browser_minus_backend_ms


class ClockSync:
    def __init__(
        self,
        *,
        window: int = 16,
        min_samples: int = 3,
        max_rtt_ms: float = 1_000.0,
        resolution_ms: float = 1.0,
        drift_ppm: float = 200.0,
        stale_after_ms: float = 30_000.0,
        degraded_uncertainty_ms: float = 25.0,
        jump_tolerance_ms: float = 50.0,
    ) -> None:
        self._samples: deque[ClockSample] = deque(maxlen=window)
        self._min_samples = min_samples
        self._max_rtt_ms = max_rtt_ms
        self._resolution_ms = resolution_ms
        self._drift = drift_ppm * 1e-6
        self._stale_after_ms = stale_after_ms
        self._degraded_uncertainty_ms = degraded_uncertainty_ms
        self._jump_tolerance_ms = jump_tolerance_ms
        self._inconsistent_streak = 0
        self.rejected_samples = 0
        self.resets = 0

    def add(self, sample: ClockSample) -> bool:
        """Add one exchange. Returns False if the sample was rejected as implausible."""
        rtt = sample.rtt_ms
        if (
            rtt < 0
            or rtt > self._max_rtt_ms
            or sample.t4_backend_recv_ms < sample.t1_backend_send_ms
            or sample.t3_browser_send_ms < sample.t2_browser_recv_ms
        ):
            self.rejected_samples += 1
            return False
        current = self.estimate(sample.t4_backend_recv_ms)
        if current is not None and current.state != "unsynchronised":
            allowed = current.uncertainty_ms + rtt / 2 + self._jump_tolerance_ms
            if abs(sample.offset_ms - current.offset_browser_minus_backend_ms) > allowed:
                # Three inconsistent samples in a row means the relationship really changed
                # (e.g. the browser's clock origin moved). Start over rather than average across it.
                self._inconsistent_streak += 1
                if self._inconsistent_streak < 3:
                    self.rejected_samples += 1
                    return False
                self._samples.clear()
                self.resets += 1
            self._inconsistent_streak = 0
        self._samples.append(sample)
        return True

    def estimate(self, now_backend_ms: float) -> ClockEstimate | None:
        if not self._samples:
            return None
        best = min(self._samples, key=lambda s: s.rtt_ms)
        age = max(0.0, now_backend_ms - best.t4_backend_recv_ms)
        uncertainty = best.rtt_ms / 2 + self._resolution_ms + age * self._drift
        newest_age = now_backend_ms - self._samples[-1].t4_backend_recv_ms
        state: ClockState
        if len(self._samples) < self._min_samples:
            state = "unsynchronised"
        elif uncertainty > self._degraded_uncertainty_ms or newest_age > self._stale_after_ms:
            state = "degraded"
        else:
            state = "synchronised"
        return ClockEstimate(
            offset_browser_minus_backend_ms=best.offset_ms,
            uncertainty_ms=uncertainty,
            best_rtt_ms=best.rtt_ms,
            sample_count=len(self._samples),
            state=state,
        )

    def usable(self, now_backend_ms: float) -> ClockEstimate | None:
        """Estimate if synchronised or degraded, else None. Callers still check uncertainty."""
        est = self.estimate(now_backend_ms)
        return est if est is not None and est.state != "unsynchronised" else None
