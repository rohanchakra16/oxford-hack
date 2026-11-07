from __future__ import annotations

import random

import pytest

from oxford_hack.timing.clock_sync import ClockSample, ClockSync


def exchange(t1: float, offset: float, d_out: float, d_back: float, proc: float = 0.2) -> ClockSample:
    t2 = t1 + d_out + offset
    t3 = t2 + proc
    t4 = t1 + d_out + proc + d_back
    return ClockSample(t1, t2, t3, t4)


def test_unsynchronised_until_minimum_samples() -> None:
    cs = ClockSync()
    assert cs.estimate(0) is None
    cs.add(exchange(1000, 5000, 2, 2))
    est = cs.estimate(1010)
    assert est is not None and est.state == "unsynchronised"
    assert cs.usable(1010) is None


@pytest.mark.parametrize("offset", [-48_480.0, 0.0, 123_456.7, 9.9e6])
def test_estimates_nonzero_offset_under_jitter(offset: float) -> None:
    rng = random.Random(3)
    cs = ClockSync()
    t = 10_000.0
    for _ in range(12):
        cs.add(exchange(t, offset, 1 + rng.random() * 20, 1 + rng.random() * 20))
        t += 500
    est = cs.usable(t)
    assert est is not None and est.state == "synchronised"
    error = abs(est.offset_browser_minus_backend_ms - offset)
    assert error <= est.uncertainty_ms  # the true offset lies inside the stated bound
    assert est.uncertainty_ms < 15
    assert est.browser_to_backend(est.backend_to_browser(777.0)) == pytest.approx(777.0)


def test_asymmetric_delay_is_bounded_by_uncertainty() -> None:
    cs = ClockSync()
    for i in range(5):
        cs.add(exchange(1000 + i * 100, 300.0, 1.0, 9.0))  # path asymmetry biases the offset by 4 ms
    est = cs.usable(1500)
    assert est is not None
    assert abs(est.offset_browser_minus_backend_ms - 300.0) == pytest.approx(4.0, abs=0.01)
    assert est.uncertainty_ms >= 4.0


def test_rejects_implausible_samples() -> None:
    cs = ClockSync()
    assert not cs.add(ClockSample(1000, 50, 40, 1010))  # browser send before receive -> negative rtt
    assert not cs.add(exchange(1000, 0, 800, 800))  # rtt above max
    assert cs.rejected_samples == 2


def test_degrades_when_samples_go_stale() -> None:
    cs = ClockSync(stale_after_ms=5_000)
    for i in range(4):
        cs.add(exchange(1000 + i * 100, 10, 1, 1))
    assert cs.estimate(1500).state == "synchronised"  # type: ignore[union-attr]
    assert cs.estimate(20_000).state == "degraded"  # type: ignore[union-attr]


def test_resets_after_persistent_clock_jump() -> None:
    cs = ClockSync()
    t = 1000.0
    for _ in range(5):
        cs.add(exchange(t, 0.0, 1, 1))
        t += 100
    # One outlier is ignored...
    assert not cs.add(exchange(t, 5_000.0, 1, 1))
    t += 100
    assert not cs.add(exchange(t, 5_000.0, 1, 1))
    t += 100
    # ...but a third consistent sample means the relationship really changed.
    assert cs.add(exchange(t, 5_000.0, 1, 1))
    assert cs.resets == 1
    assert cs.estimate(t).offset_browser_minus_backend_ms == pytest.approx(5_000.0)  # type: ignore[union-attr]
