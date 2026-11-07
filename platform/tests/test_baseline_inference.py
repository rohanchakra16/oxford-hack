"""Integration: Person 3's synthetic-only BaselineInference driven by the platform hub.

This exercises the real adapter from inference/ (repository root) on SYNTHETIC EEG through the
same contract path as live sessions. It proves wiring and timing, not detection quality.
"""

from __future__ import annotations

import sys
from pathlib import Path

from oxford_hack.harness.sim import Sim, SimPlayer
from oxford_hack.harness.synthetic import QualityEvent, simulation_factory
from oxford_hack.session.hub import Hub, IdFactory
from oxford_hack.timing.clock import ManualClock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from inference.adapter import BaselineInference


def factory(clock: ManualClock) -> Hub:
    return Hub(
        clock,
        simulation_factory=simulation_factory(
            detector_factory=BaselineInference, seed=3, script=(QualityEvent(30_000, 45_000, "elevated"),)
        ),
        ids=IdFactory("bl"),
        backend_instance_id="be-bl",
    )


def test_baseline_detector_runs_through_hub_on_synthetic_eeg() -> None:
    sim = Sim(factory, seed=2)
    b = sim.browser()
    b.connect()
    sim.run(1_000)
    b.start_session("video-bl", eeg=True, gaze=False)
    sim.run(200)
    config = b.of_type("session_config")[0]["payload"]
    assert config["detector"]["detectorId"] == "experimental-rule-baseline"
    player = SimPlayer(b, "video-bl")
    player.media_s = 10.0
    player.play()
    sim.run(90_000)
    errors = [m["payload"] for m in b.of_type("error")]
    assert errors == []
    marks = [m["payload"] for m in b.of_type("review_bookmark")]
    rejected = [m["payload"]["reason"] for m in b.of_type("candidate_rejected")]
    assert rejected == []
    assert marks, "baseline produced no bookmark during the scripted elevated interval"
    for bm in marks:
        assert bm["runKind"] == "simulated" and bm["source"] == "experimental_eeg"
        assert bm["detector"]["detectorId"] == "experimental-rule-baseline"
        # Elevated windows end 30-45 s after producer start (~1.2 s before playback began, at media 10 s),
        # so the evidence must map inside media ~[34, 55] s.
        assert 30.0 <= bm["evidenceMedia"]["startMediaS"] <= bm["evidenceMedia"]["endMediaS"] <= 56.0
