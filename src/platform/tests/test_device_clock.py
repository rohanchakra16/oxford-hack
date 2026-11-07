from __future__ import annotations

import pytest

from oxford_hack.timing.device_clock import FixedOffsetMapper, LinearFitMapper


def test_fixed_offset_mapper() -> None:
    m = FixedOffsetMapper(offset_s=-1000.0, uncertainty_ms=2.0, method="lsl_time_correction")
    mapped = m.to_backend_ms(1005.5)
    assert mapped is not None and mapped.backend_ms == pytest.approx(5500.0)
    assert m.correction().method == "lsl_time_correction"
    assert m.to_backend_ms(10.0) is None  # would be before the backend clock origin


def test_linear_fit_recovers_offset_and_drift() -> None:
    m = LinearFitMapper()
    assert m.to_backend_ms(1.0) is None  # not enough pairs yet
    drift = 50e-6  # device runs 50 ppm slow relative to backend
    for i in range(20):
        device_s = 100.0 + i
        m.add_pair(device_s, 7_000.0 + (device_s - 100.0) * 1000.0 * (1 + drift), 0.5)
    mapped = m.to_backend_ms(110.0)
    assert mapped is not None
    assert mapped.backend_ms == pytest.approx(7_000.0 + 10_000.0 * (1 + drift), abs=0.01)
    corr = m.correction()
    assert corr.method == "linear_fit" and corr.drift_ppm == pytest.approx(50.0, abs=0.5)


def test_linear_fit_refuses_far_extrapolation() -> None:
    m = LinearFitMapper(max_extrapolation_s=5.0)
    for i in range(5):
        m.add_pair(float(i), 1000.0 + i * 1000.0)
    assert m.to_backend_ms(8.0) is not None
    assert m.to_backend_ms(20.0) is None
