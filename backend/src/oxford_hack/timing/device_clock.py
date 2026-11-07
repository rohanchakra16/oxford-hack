"""Acquisition-device / LSL clock -> backend clock.

Person 1 chooses the mapper that matches the real acquisition route and applies it before
publishing EegFeatureWindow.evidence (backend ms). The original device timestamps and the
ClockCorrection description travel with every window so the conversion can be audited.

Nothing here assumes the device clock shares an origin or a rate with the backend clock.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import Protocol

from ..contracts.payloads import ClockCorrection


@dataclass(frozen=True)
class MappedTime:
    backend_ms: float
    uncertainty_ms: float


class DeviceClockMapper(Protocol):
    def to_backend_ms(self, device_s: float) -> MappedTime | None:
        """Backend time for a device timestamp, or None if the mapping cannot be trusted."""
        ...

    def correction(self) -> ClockCorrection:
        """Description attached to each EegFeatureWindow."""
        ...


class FixedOffsetMapper:
    """backend_ms = (device_s + offset_s) * 1000.

    Use when an external tool supplies a measured offset, e.g. LSL ``inlet.time_correction()``
    combined with a measured LSL-local-clock -> backend-clock offset. ``method`` records which.
    """

    def __init__(
        self,
        offset_s: float,
        uncertainty_ms: float,
        method: str = "fixed_offset",
    ) -> None:
        if method not in ("fixed_offset", "lsl_time_correction", "same_clock"):
            raise ValueError(f"unknown method {method}")
        self._offset_s = offset_s
        self._uncertainty_ms = uncertainty_ms
        self._method = method

    def to_backend_ms(self, device_s: float) -> MappedTime | None:
        backend_ms = (device_s + self._offset_s) * 1000.0
        if backend_ms < 0:
            return None
        return MappedTime(backend_ms, self._uncertainty_ms)

    def correction(self) -> ClockCorrection:
        return ClockCorrection(
            method=self._method,  # type: ignore[arg-type]
            offset_s=self._offset_s,
            drift_ppm=None,
            uncertainty_ms=self._uncertainty_ms,
        )


class LinearFitMapper:
    """Fits backend_ms = a + b * device_s from paired readings (handles offset AND drift).

    Feed it pairs observed at (nearly) the same instant, e.g. ``(lsl_local_clock(), clock.now_ms())``
    sampled back-to-back, or (device timestamp, arrival time) pairs, giving each pair's own
    uncertainty. Arrival-time pairs include transport latency, so prefer paired clock readings.
    """

    def __init__(
        self,
        *,
        window: int = 64,
        min_pairs: int = 4,
        max_extrapolation_s: float = 30.0,
        max_uncertainty_ms: float = 20.0,
    ) -> None:
        self._pairs: deque[tuple[float, float, float]] = deque(maxlen=window)
        self._min_pairs = min_pairs
        self._max_extrapolation_s = max_extrapolation_s
        self._max_uncertainty_ms = max_uncertainty_ms
        self._fit: tuple[float, float, float] | None = None  # a, b, residual_rms_ms

    def add_pair(self, device_s: float, backend_ms: float, pair_uncertainty_ms: float = 1.0) -> None:
        self._pairs.append((device_s, backend_ms, pair_uncertainty_ms))
        self._fit = None

    def _fitted(self) -> tuple[float, float, float] | None:
        if self._fit is not None:
            return self._fit
        n = len(self._pairs)
        if n < self._min_pairs:
            return None
        xs = [x for x, _, _ in self._pairs]
        ys = [y for _, y, _ in self._pairs]
        mx = sum(xs) / n
        my = sum(ys) / n
        sxx = sum((x - mx) ** 2 for x in xs)
        if sxx == 0:
            return None
        b = sum((x - mx) * (y - my) for x, y in zip(xs, ys, strict=True)) / sxx
        a = my - b * mx
        rms = (sum((y - (a + b * x)) ** 2 for x, y in zip(xs, ys, strict=True)) / n) ** 0.5
        self._fit = (a, b, rms)
        return self._fit

    def to_backend_ms(self, device_s: float) -> MappedTime | None:
        fit = self._fitted()
        if fit is None:
            return None
        a, b, rms = fit
        lo = min(x for x, _, _ in self._pairs)
        hi = max(x for x, _, _ in self._pairs)
        outside = max(0.0, lo - device_s, device_s - hi)
        if outside > self._max_extrapolation_s:
            return None
        pair_unc = max(u for _, _, u in self._pairs)
        drift_extra = abs(b / 1000.0 - 1.0) * outside * 1000.0
        uncertainty = 2 * rms + pair_unc + drift_extra
        if uncertainty > self._max_uncertainty_ms:
            return None
        return MappedTime(a + b * device_s, uncertainty)

    def correction(self) -> ClockCorrection:
        fit = self._fitted()
        if fit is None:
            return ClockCorrection(method="linear_fit", offset_s=None, drift_ppm=None, uncertainty_ms=None)
        a, b, rms = fit
        return ClockCorrection(
            method="linear_fit",
            offset_s=a / 1000.0,
            drift_ppm=(b / 1000.0 - 1.0) * 1e6,
            uncertainty_ms=2 * rms,
        )
