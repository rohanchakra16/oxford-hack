"""Generate the SYNTHETIC sample recording used by replay tests and docs.

Usage: uv run python scripts/make_sample_recording.py [--check]
Writes contracts/fixtures/recordings/synthetic-session.v1.jsonl (all values synthetic).
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

from oxford_hack.harness.replay import JsonlRecorder
from oxford_hack.harness.sim import Sim, SimPlayer
from oxford_hack.harness.synthetic import QualityEvent, simulation_factory
from oxford_hack.session.hub import Hub, IdFactory
from oxford_hack.timing.clock import ManualClock

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "contracts" / "fixtures" / "recordings" / "synthetic-session.v1.jsonl"


def build() -> str:
    buf = io.StringIO()

    def factory(clock: ManualClock) -> Hub:
        recorder = JsonlRecorder(
            buf,
            clock,
            synthetic=True,
            description="SYNTHETIC: simulated session with seek, rate change and an EEG dropout",
            detector={
                "detectorId": "placeholder-scripted",
                "detectorVersion": "0.1.0",
                "configVersion": "every-8000ms",
                "evaluatedModes": [],
            },
        )
        return Hub(
            clock,
            ids=IdFactory("rec"),
            backend_instance_id="be-rec",
            recorder=recorder,
            simulation_factory=simulation_factory(
                period_ms=8_000, script=(QualityEvent(30_000, 36_000, "dropout"),)
            ),
        )

    sim = Sim(factory, seed=5)
    b = sim.browser("rec-client", offset_ms=86_400_000.0)
    b.connect()
    sim.run(1_000)
    b.start_session("synthetic-lecture")
    sim.run(200)
    player = SimPlayer(b, "synthetic-lecture")
    player.media_s = 60.0
    player.play()
    sim.run(20_000)
    player.seek(15.0)
    sim.run(12_000)
    player.set_rate(1.5)
    sim.run(15_000)
    player.pause()
    sim.run(2_000)
    return buf.getvalue()


def main() -> int:
    text = build()
    if "--check" in sys.argv:
        if not OUT.exists() or OUT.read_text() != text:
            print(f"{OUT.relative_to(ROOT)} is out of date: run this script", file=sys.stderr)
            return 1
        print("sample recording up to date")
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text)
    print(f"wrote {OUT.relative_to(ROOT)} ({len(text.splitlines())} lines)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
