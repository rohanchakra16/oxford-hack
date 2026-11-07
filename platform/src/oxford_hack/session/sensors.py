"""Sensor availability and operating mode. Owner: Person 5.

This tracks whether each sensor is *delivering usable data*. It says nothing about attention.
"Sensor unavailable" and "possible lapse" are different things and are reported separately.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

from ..contracts.base import OperatingMode
from ..contracts.payloads import (
    EegFeatureWindow,
    EegStatus,
    GazeCalibration,
    GazeObservationBatch,
    ModePolicy,
    SensorState,
    SensorStateName,
    SensorStatus,
)


@dataclass
class SensorTimeouts:
    eeg_lost_ms: float = 3_000.0
    gaze_lost_ms: float = 2_000.0
    gaze_coverage_window_ms: float = 3_000.0
    gaze_min_valid_fraction: float = 0.5


@dataclass
class _Tracked:
    state: SensorStateName
    reasons: list[str]
    since_ms: float


@dataclass
class SensorMonitor:
    eeg_enabled: bool
    gaze_enabled: bool
    policy: ModePolicy
    has_detector: bool
    run_kind: str
    timeouts: SensorTimeouts = field(default_factory=SensorTimeouts)
    experimental_modes: frozenset[str] = frozenset()
    _eeg_status: EegStatus | None = None
    _eeg_status_recv_ms: float | None = None
    _eeg_window: EegFeatureWindow | None = None
    _eeg_window_recv_ms: float | None = None
    _gaze_last_recv_ms: float | None = None
    _gaze_recent: deque[tuple[float, bool]] = field(default_factory=lambda: deque(maxlen=512))
    _gaze_head_only: bool = False
    _calibration: GazeCalibration | None = None
    _eeg: _Tracked | None = None
    _gaze: _Tracked | None = None
    _last: SensorStatus | None = None

    def on_eeg_status(self, s: EegStatus, now_ms: float) -> None:
        self._eeg_status, self._eeg_status_recv_ms = s, now_ms

    def on_eeg_window(self, w: EegFeatureWindow, now_ms: float) -> None:
        self._eeg_window, self._eeg_window_recv_ms = w, now_ms

    def on_gaze(self, batch: GazeObservationBatch, now_ms: float) -> None:
        self._gaze_last_recv_ms = now_ms
        for o in batch.observations:
            self._gaze_recent.append((now_ms, o.valid))
            self._gaze_head_only = o.measurement_kind == "head_direction"

    def on_calibration(self, c: GazeCalibration) -> None:
        self._calibration = c

    def _eeg_state(self, now: float) -> tuple[SensorStateName, list[str]]:
        if not self.eeg_enabled:
            return "disabled", ["EEG not requested for this session"]
        last_ms = max(self._eeg_status_recv_ms or -1.0, self._eeg_window_recv_ms or -1.0)
        if last_ms < 0:
            return "unavailable", ["no EEG source has reported"]
        if now - last_ms > self.timeouts.eeg_lost_ms:
            return "lost", [f"no EEG data within {self.timeouts.eeg_lost_ms / 1000:.1f} s"]
        status = self._eeg_status
        if status is not None and status.state in ("connecting", "warming_up", "lost", "unavailable"):
            return status.state, [f.replace("_", " ") for f in status.flags]
        w = self._eeg_window
        if w is None:
            return "warming_up", ["waiting for the first complete feature window"]
        if not w.quality.usable:
            return "degraded", [f.replace("_", " ") for f in w.quality.flags] or ["window unusable"]
        return "ok", [f.replace("_", " ") for f in w.quality.flags]

    def _gaze_state(self, now: float) -> tuple[SensorStateName, list[str]]:
        if not self.gaze_enabled:
            return "disabled", ["gaze not requested for this session"]
        if self._gaze_last_recv_ms is None:
            return "unavailable", ["no gaze observations received"]
        if now - self._gaze_last_recv_ms > self.timeouts.gaze_lost_ms:
            return "lost", [f"no gaze observations within {self.timeouts.gaze_lost_ms / 1000:.1f} s"]
        cal = self._calibration
        if cal is None or cal.status != "valid":
            return "degraded", [f"calibration {cal.status if cal else 'missing'}"]
        window = [v for t, v in self._gaze_recent if now - t <= self.timeouts.gaze_coverage_window_ms]
        fraction = sum(window) / len(window) if window else 0.0
        reasons = ["head direction only, not screen gaze"] if self._gaze_head_only else []
        if fraction < self.timeouts.gaze_min_valid_fraction:
            return "degraded", [*reasons, f"valid coverage below {self.timeouts.gaze_min_valid_fraction:.0%}"]
        return "ok", reasons

    def _track(
        self, prev: _Tracked | None, state: SensorStateName, reasons: list[str], now: float
    ) -> _Tracked:
        if prev is not None and prev.state == state:
            prev.reasons = reasons
            return prev
        return _Tracked(state, reasons, now)

    def status(self, now_ms: float) -> SensorStatus:
        self._eeg = self._track(self._eeg, *self._eeg_state(now_ms), now_ms)
        self._gaze = self._track(self._gaze, *self._gaze_state(now_ms), now_ms)
        eeg_ok = self._eeg.state == "ok"
        gaze_ok = self._gaze.state == "ok"
        mode: OperatingMode = (
            "both"
            if eeg_ok and gaze_ok
            else "eeg_only"
            if eeg_ok
            else "gaze_only"
            if gaze_ok
            else "manual_only"
        )
        if (
            mode == "both"
            and self.policy.both != "automatic"
            and "eeg_only" in self.experimental_modes
            and self.policy.eeg_only == "automatic"
        ):
            mode = "eeg_only"  # EEG detector remains usable when an extra gaze sensor is available.
        if mode == "manual_only":
            automatic, reason = False, "no sensor is delivering usable data"
        elif not self.has_detector:
            automatic, reason = False, "no detector configured"
        elif getattr(self.policy, mode) != "automatic":
            automatic, reason = False, f"mode {mode} has not been evaluated; manual recovery only"
        else:
            automatic = True
            reason = f"mode {mode} is automatic" + (
                " (simulated run)" if self.run_kind == "simulated" else ""
            )
            if mode in self.experimental_modes:
                reason += " (experimental live reminders; not validated)"
        return SensorStatus(
            eeg=SensorState(
                state=self._eeg.state, reasons=self._eeg.reasons, since_backend_ms=self._eeg.since_ms
            ),
            gaze=SensorState(
                state=self._gaze.state, reasons=self._gaze.reasons, since_backend_ms=self._gaze.since_ms
            ),
            mode=mode,
            automatic_suggestions=automatic,
            automatic_reason=reason,
            t_backend_ms=now_ms,
        )

    def changed(self, now_ms: float) -> SensorStatus | None:
        """Current status if it differs (ignoring timestamps) from the last returned one."""
        cur = self.status(now_ms)
        key = cur.model_copy(update={"t_backend_ms": 0.0})
        if self._last is not None and self._last.model_copy(update={"t_backend_ms": 0.0}) == key:
            return None
        self._last = cur
        return cur
