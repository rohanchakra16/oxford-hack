"""``serve`` wiring: --eeg-source and --simulated-detector reach the hub (no port is bound)."""

from __future__ import annotations

import argparse
import time

import pytest

from oxford_hack.cli import build_hub_factory
from oxford_hack.eeg.bridge import EegSourceLoadError, load_source_factory
from oxford_hack.harness.sim import Sim
from oxford_hack.inference.interface import SessionContext
from oxford_hack.session.hub import HubSettings
from oxford_hack.timing.clock import ManualClock

from . import fake_eeg_source


def args(**kw: object) -> argparse.Namespace:
    base: dict[str, object] = {
        "allow_simulated": True,
        "simulated_detector": "placeholder",
        "eeg_source": None,
    }
    base.update(kw)
    return argparse.Namespace(**base)


def test_simulated_detector_baseline_reaches_simulated_sessions() -> None:
    factory = build_hub_factory(args(simulated_detector="baseline"), HubSettings())
    hub = factory(ManualClock(1_000.0))
    assert hub._simulation_factory is not None
    _, inference = hub._simulation_factory(SessionContext("s1", "v1", "simulated", True, False))
    assert inference is not None and type(inference).__name__ == "BaselineInference"


def test_default_simulated_detector_is_the_placeholder() -> None:
    hub = build_hub_factory(args(), HubSettings())(ManualClock(1_000.0))
    assert hub._simulation_factory is not None
    _, inference = hub._simulation_factory(SessionContext("s1", "v1", "simulated", True, False))
    assert inference is not None and type(inference).__name__ == "PlaceholderInference"


def test_eeg_source_feeds_live_sessions_only_and_is_stopped_on_shutdown() -> None:
    fake_eeg_source.INSTANCES.clear()
    factory = build_hub_factory(
        args(eeg_source="tests.fake_eeg_source:make_source", allow_simulated=False),
        HubSettings(allowed_run_kinds=frozenset({"live"})),
    )
    sim = Sim(factory)
    b = sim.browser("c1")
    b.connect()
    sim.run(1_000)
    b.start_session("video-a", eeg=True, gaze=False, run_kind="live")
    for _ in range(40):  # let the source thread publish between simulated ticks
        sim.run(100)
        time.sleep(0.01)
    status = b.of_type("sensor_status")[-1]["payload"]
    assert status["eeg"]["state"] != "unavailable"  # the real-source status arrived
    (source,) = fake_eeg_source.INSTANCES
    assert source.started and not source.stopped
    sim.hub.shutdown()
    assert source.stopped


def test_without_eeg_source_live_eeg_stays_unavailable() -> None:
    sim = Sim(
        build_hub_factory(args(allow_simulated=False), HubSettings(allowed_run_kinds=frozenset({"live"})))
    )
    b = sim.browser("c1")
    b.connect()
    sim.run(1_000)
    b.start_session("video-a", eeg=True, gaze=False, run_kind="live")
    sim.run(2_000)
    assert b.of_type("sensor_status")[-1]["payload"]["eeg"]["state"] == "unavailable"


@pytest.mark.parametrize("spec", ["nocolon", "no.such.module:x", "tests.fake_eeg_source:missing", "a b:c"])
def test_bad_eeg_source_specs_are_reported(spec: str) -> None:
    with pytest.raises(EegSourceLoadError):
        load_source_factory(spec)
