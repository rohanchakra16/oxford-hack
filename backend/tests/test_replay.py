from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from oxford_hack.harness.replay import RecordingError, read_recording, run_replay

ROOT = Path(__file__).resolve().parents[2]
SAMPLE = ROOT / "contracts" / "fixtures" / "recordings" / "synthetic-session.v1.jsonl"


def test_sample_is_synthetic_and_up_to_date() -> None:
    header, records = read_recording(SAMPLE)
    assert header["synthetic"] is True
    assert {r["from"] for r in records} >= {"browser", "eeg", "inference", "clock"}
    script = ROOT / "backend" / "scripts" / "make_sample_recording.py"
    assert subprocess.run([sys.executable, str(script), "--check"], capture_output=True).returncode == 0


def test_replay_is_deterministic_and_labelled_replay() -> None:
    first, second = list(run_replay(SAMPLE)), list(run_replay(SAMPLE))
    assert first == second
    msgs = [json.loads(line) for line in first]
    marks = [m["payload"] for m in msgs if m["type"] == "review_bookmark"]
    assert marks and all(b["runKind"] == "replay" for b in marks)


def test_replay_reproduces_recorded_candidates() -> None:
    _, records = read_recording(SAMPLE)
    recorded = {r["message"]["payload"]["eventId"] for r in records if r["from"] == "inference"}
    msgs = [json.loads(line) for line in run_replay(SAMPLE)]
    mapped = {m["payload"]["eventId"] for m in msgs if m["type"] == "review_bookmark"}
    rejected = {m["payload"]["eventId"] for m in msgs if m["type"] == "candidate_rejected"}
    assert mapped | rejected == recorded
    assert not rejected  # the synthetic session only produced mappable candidates
    seg_of = {
        m["payload"]["eventId"]: m["payload"]["segmentId"] for m in msgs if m["type"] == "review_bookmark"
    }
    assert len(set(seg_of.values())) >= 3  # seek and rate change produced separate segments


def test_rejects_wrong_format(tmp_path: Path) -> None:
    bad = tmp_path / "x.jsonl"
    bad.write_text('{"format": "something-else"}\n')
    with pytest.raises(RecordingError):
        read_recording(bad)
    bad.write_text(
        json.dumps({"format": "oxford-hack-recording", "formatVersion": 1, "schemaVersion": "9"}) + "\n"
    )
    with pytest.raises(RecordingError, match="schema"):
        read_recording(bad)
