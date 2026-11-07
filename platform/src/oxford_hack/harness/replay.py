"""Recorded-message replay. Format: docs/REPLAY.md. Owner: Person 5.

A recording is JSONL. Line 1 is a header; every other line is one accepted message:

    {"format": "oxford-hack-recording", "formatVersion": 1, "schemaVersion": "0.2.0",
     "synthetic": true, "description": "...", "backendStartMs": 10000.0,
     "detector": {"detectorId": ..., "detectorVersion": ..., "configVersion": ...,
                  "evaluatedModes": ["eeg_only"]} | null}
    {"atMs": 10500.0, "from": "clock",     "offsetBrowserMinusBackendMs": 123456.7}
    {"atMs": 10520.0, "from": "browser",   "message": {<envelope>}}
    {"atMs": 15100.0, "from": "eeg",       "message": {<eeg_features | eeg_status envelope>}}
    {"atMs": 16050.0, "from": "inference", "message": {<review_candidate envelope>}}

``atMs`` is the backend clock when the message was accepted. Replay re-runs everything through a
fresh Hub on a ManualClock with a simulated browser at the recorded clock offset, so the output is
deterministic. Every replayed session, message and bookmark is relabelled ``runKind: "replay"``;
replay is never presented as live.
"""

from __future__ import annotations

import json
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import Any, TextIO

from ..contracts import SCHEMA_VERSION, AnyMessage, dumps, validate_message
from ..contracts import payloads as p
from ..contracts.base import AutomaticMode
from ..inference.interface import MappedGazeObservation, SessionContext
from ..session.hub import Hub, HubSettings, IdFactory
from ..timing.clock import Clock, ManualClock
from .sim import Sim

FORMAT = "oxford-hack-recording"
FORMAT_VERSION = 1
OUTPUT_TYPES = ("review_bookmark", "candidate_rejected", "sensor_status", "playback_eligibility", "error")


class RecordingError(Exception):
    pass


class JsonlRecorder:
    """Hub recorder writing the replay format. Opt-in only; write under .local/ (git-ignored)."""

    def __init__(
        self,
        out: TextIO,
        clock: Clock,
        *,
        synthetic: bool,
        description: str,
        detector: dict[str, Any] | None = None,
    ) -> None:
        self._out = out
        self._clock = clock
        self._last_offset: float | None = None
        header = {
            "format": FORMAT,
            "formatVersion": FORMAT_VERSION,
            "schemaVersion": SCHEMA_VERSION,
            "synthetic": synthetic,
            "description": description,
            "backendStartMs": clock.now_ms(),
            "detector": detector,
        }
        self._write(header)

    def _write(self, obj: dict[str, Any]) -> None:
        self._out.write(json.dumps(obj, separators=(",", ":"), allow_nan=False) + "\n")

    def clock_offset(self, offset_ms: float | None) -> None:
        if offset_ms is not None and (self._last_offset is None or abs(offset_ms - self._last_offset) > 1.0):
            self._last_offset = offset_ms
            self._write(
                {"atMs": self._clock.now_ms(), "from": "clock", "offsetBrowserMinusBackendMs": offset_ms}
            )

    def __call__(self, source: str, message: AnyMessage, backend_ms: float) -> None:
        self._write({"atMs": backend_ms, "from": source, "message": json.loads(dumps(message))})


class ReplayInference:
    """Declares the recorded detector's evaluated modes; candidates are injected from the recording."""

    def __init__(self, detector: dict[str, Any]) -> None:
        self._detector = p.DetectorInfo(
            detector_id=detector["detectorId"],
            detector_version=detector["detectorVersion"],
            config_version=detector["configVersion"],
        )
        self._modes = frozenset(detector.get("evaluatedModes", []))

    @property
    def detector(self) -> p.DetectorInfo:
        return self._detector

    @property
    def evaluated_modes(self) -> frozenset[AutomaticMode]:
        return self._modes

    def on_eeg_window(self, window: p.EegFeatureWindow) -> None: ...
    def on_gaze(self, observations: Sequence[MappedGazeObservation]) -> None: ...
    def on_gaze_calibration(self, calibration: p.GazeCalibration) -> None: ...
    def on_eligibility(self, eligibility: p.PlaybackEligibility) -> None: ...
    def on_sensor_status(self, status: p.SensorStatus) -> None: ...

    def poll(self, now_backend_ms: float) -> list[p.ReviewCandidate]:
        return []

    def close(self) -> None: ...


def _relabel(obj: Any) -> Any:
    """Force every runKind in a message to 'replay'."""
    if isinstance(obj, dict):
        return {k: ("replay" if k == "runKind" else _relabel(v)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_relabel(v) for v in obj]
    return obj


def read_recording(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    lines = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    if not lines or lines[0].get("format") != FORMAT:
        raise RecordingError(f"{path}: not an {FORMAT} file")
    header = lines[0]
    if header.get("formatVersion") != FORMAT_VERSION:
        raise RecordingError(f"unsupported formatVersion {header.get('formatVersion')!r}")
    if header.get("schemaVersion") != SCHEMA_VERSION:
        raise RecordingError(
            f"recording uses schema {header.get('schemaVersion')!r}, this tool {SCHEMA_VERSION!r}"
        )
    return header, lines[1:]


def run_replay(path: Path, *, seed: int = 1) -> Iterator[str]:
    """Replay a recording and yield one canonical JSON line per output message (deterministic)."""
    header, records = read_recording(path)
    offsets = [r["offsetBrowserMinusBackendMs"] for r in records if r["from"] == "clock"]
    if not offsets:
        raise RecordingError("recording has no clock line; cannot reconstruct browser time")
    detector = header.get("detector")

    def hub_factory(clock: ManualClock) -> Hub:
        def inference_factory(ctx: SessionContext) -> ReplayInference | None:
            return ReplayInference(detector) if detector else None

        # A fully synthetic recording may replay under the simulation-only policy; real
        # recordings only get automatic suggestions for modes their detector declares evaluated.
        sim_kinds = frozenset({"replay"}) if header.get("synthetic") is True else frozenset()
        return Hub(
            clock,
            settings=HubSettings(
                allowed_run_kinds=frozenset({"replay"}), simulation_policy_run_kinds=sim_kinds
            ),
            inference_factory=inference_factory,
            ids=IdFactory("replay"),
            backend_instance_id="be-replay",
        )

    start = float(header["backendStartMs"]) - 1_000.0
    sim = Sim(hub_factory, seed=seed, start_ms=max(0.0, start), jitter_ms=0.0)
    browser = sim.browser("replay-client", offset_ms=offsets[0])
    browser.connect()
    sim.run(1_000)
    for rec in records:
        at = float(rec["atMs"])
        if at > sim.clock.now_ms():
            sim.run(at - sim.clock.now_ms())
        if rec["from"] == "clock":
            continue
        message = _relabel(rec["message"])
        validate_message(message)  # recordings must still satisfy the contract
        if rec["from"] == "browser":
            message["sessionId"] = None if message["type"] == "session_start" else browser.session_id
            message["seq"] = browser.seq
            browser.seq += 1
            browser.send_raw(json.dumps(message))
        elif rec["from"] in ("eeg", "inference"):
            msg = validate_message(message)
            sim.hub.ingest_internal(msg.payload, session_id=browser.session_id)  # type: ignore[arg-type]
        else:
            raise RecordingError(f"unknown source {rec['from']!r}")
    sim.run(5_000)
    for m in browser.received:
        if m["type"] in OUTPUT_TYPES:
            yield json.dumps({k: v for k, v in m.items() if k != "messageId"}, sort_keys=True)
