"""Write synthetic contract fixtures used by backend and frontend tests and by teammates.

Usage: uv run python scripts/make_fixtures.py [--check]

contracts/fixtures/valid/<type>.json      one valid example per message type
contracts/fixtures/invalid/<case>.json    {description, expectedCode, layer, raw}
  layer "structural": the JSON Schema alone rejects it (frontend and backend)
  layer "semantic":   only the backend's cross-field rules reject it
All values are synthetic. No real participant or device data.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from oxford_hack.contracts import MESSAGES, dumps, envelope
from oxford_hack.contracts import payloads as p
from oxford_hack.contracts.base import Contract

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "contracts" / "fixtures"

SIM = p.Provenance(run_kind="simulated", producer="fixture-generator", producer_version="0.1.0")
DETECTOR = p.DetectorInfo(
    detector_id="placeholder-scripted", detector_version="0.1.0", config_version="sim-1"
)
DEVICE = p.EegDeviceInfo(model=None, confirmed=False, sample_rate_hz=None, channel_names=None, units=None)
MAPPING = p.MappingConfig(
    lead_in_s=2.0,
    boundary_margin_ms=250.0,
    max_clock_uncertainty_ms=50.0,
    max_telemetry_staleness_ms=2500.0,
    pending_timeout_ms=3000.0,
    max_candidate_age_ms=30000.0,
)
CONFIG = p.SessionConfig(
    session_id="ses-fixture",
    video_id="video-fixture",
    run_kind="simulated",
    enabled_sensors=p.RequestedSensors(eeg=True, gaze=True),
    mode_policy=p.ModePolicy(both="automatic", eeg_only="automatic", gaze_only="automatic"),
    detector=DETECTOR,
    eeg_device=DEVICE,
    feature_set_version="synthetic-features-0",
    mapping=MAPPING,
    created_backend_ms=1000.0,
)
SIGNALS = [
    p.ContributingSignal(
        signal="eeg",
        window_ids=["eegw-12"],
        scores=[p.SignalScore(name="placeholder", value=None, scale="none", missing_reason="no model")],
    ),
    p.ContributingSignal(
        signal="gaze",
        window_ids=["gazew-12"],
        scores=[
            p.SignalScore(
                name="outside_video_fraction", value=0.6, scale="fraction_of_window", missing_reason=None
            )
        ],
    ),
]
BOOKMARK = p.ReviewBookmark(
    bookmark_id="bm-evt-1",
    event_id="evt-1",
    video_id="video-fixture",
    segment_id="seg-2",
    source="experimental_combined",
    run_kind="simulated",
    suggested_media_s=40.0,
    evidence_media=p.MediaInterval(start_media_s=42.0, end_media_s=46.0),
    evidence=p.BackendInterval(start_backend_ms=52000.0, end_backend_ms=56000.0),
    decision_backend_ms=56200.0,
    mapped_backend_ms=56250.0,
    mapping_uncertainty_ms=3.5,
    detector=DETECTOR,
    contributing_signals=SIGNALS,
    transcript_context=None,
)
SENSORS = p.SensorStatus(
    eeg=p.SensorState(state="ok", reasons=[], since_backend_ms=2000.0),
    gaze=p.SensorState(state="degraded", reasons=["calibration expired"], since_backend_ms=3000.0),
    mode="eeg_only",
    automatic_suggestions=True,
    automatic_reason="mode eeg_only is automatic (simulated run)",
    t_backend_ms=3000.0,
)
RECT = p.CssRect(x=0, y=0, width=1280, height=800)

PAYLOADS: dict[str, Contract] = {
    "client_hello": p.ClientHello(
        client_instance_id="client-abc",
        session_token="tok_0123456789abcdef",
        resume=p.ResumeRequest(session_id="ses-fixture", backend_instance_id="be-1", last_received_seq=7),
        capabilities=p.ClientCapabilities(playback_telemetry=True, gaze=True, diagnostics=True),
        t_browser_ms=1520.5,
    ),
    "server_hello": p.ServerHello(
        backend_instance_id="be-1",
        connection_id="conn-1",
        resume_outcome="resumed",
        session_id="ses-fixture",
        heartbeat_interval_ms=2000.0,
        heartbeat_timeout_ms=6000.0,
        t_backend_ms=50000.0,
    ),
    "heartbeat": p.Heartbeat(clock="browser", sent_ms=1600.0),
    "clock_ping": p.ClockPing(ping_id="ping-1", t_backend_send_ms=50010.0),
    "clock_pong": p.ClockPong(
        ping_id="ping-1", t_backend_send_ms=50010.0, t_browser_recv_ms=1530.2, t_browser_send_ms=1530.4
    ),
    "clock_status": p.ClockStatus(
        state="synchronised",
        offset_browser_minus_backend_ms=-48480.0,
        uncertainty_ms=1.8,
        best_rtt_ms=3.2,
        sample_count=8,
        t_backend_ms=50100.0,
    ),
    "session_start": p.SessionStart(
        video_id="video-fixture",
        run_kind="simulated",
        requested_sensors=p.RequestedSensors(eeg=True, gaze=True),
        media_duration_s=600.0,
    ),
    "session_end": p.SessionEnd(reason="video_changed"),
    "session_config": CONFIG,
    "session_ended": p.SessionEnded(reason="client_ended"),
    "session_snapshot": p.SessionSnapshot(
        config=CONFIG, bookmarks=[BOOKMARK], sensor_status=SENSORS, last_seq=41
    ),
    "error": p.ErrorReport(
        code="schema_version_mismatch",
        message="received schemaVersion '0.2.0'; this component supports exactly '0.1.0'",
        ref_message_id="m-99",
        fatal=True,
        details={"received": "0.2.0"},
    ),
    "playback_state": p.PlaybackState(
        video_id="video-fixture",
        segment_id="seg-2",
        event="playing",
        state="playing",
        t_browser_ms=3520.0,
        media_time_s=42.0,
        playback_rate=1.25,
        media_duration_s=600.0,
        telemetry_seq=12,
    ),
    "playback_eligibility": p.PlaybackEligibility(
        video_id="video-fixture",
        segment_id=None,
        eligible=False,
        reason="seeking",
        epoch=5,
        eligible_since_backend_ms=None,
        t_backend_ms=60000.0,
    ),
    "eeg_features": p.EegFeatureWindow(
        window_id="eegw-12",
        stream_id="synthetic-eeg",
        feature_set_version="synthetic-features-0",
        evidence=p.BackendInterval(start_backend_ms=52000.0, end_backend_ms=56000.0),
        device_evidence_start_device_s=10452.0,
        device_evidence_end_device_s=10456.0,
        clock_correction=p.ClockCorrection(
            method="fixed_offset", offset_s=-10400.0, drift_ppm=None, uncertainty_ms=2.0
        ),
        samples=p.SampleCounts(expected=1000, received=998),
        channels=["ch-a", "ch-b"],
        features=[
            p.EegFeature(name="synthetic_power", unit="a.u.", channel="ch-a", value=0.0, missing_reason=None),
            p.EegFeature(
                name="synthetic_power",
                unit="a.u.",
                channel="ch-b",
                value=None,
                missing_reason="channel rejected: flatline",
            ),
        ],
        quality=p.EegWindowQuality(
            usable=True,
            flags=["missing_samples"],
            channels=[
                p.EegChannelQuality(channel="ch-a", state="good", flags=[]),
                p.EegChannelQuality(channel="ch-b", state="bad", flags=["flatline"]),
            ],
        ),
        t_processed_backend_ms=56050.0,
        provenance=SIM,
    ),
    "eeg_status": p.EegStatus(
        stream_id="synthetic-eeg",
        state="ok",
        flags=["units_unverified"],
        device=DEVICE,
        dropped_packets=0,
        t_backend_ms=56000.0,
        provenance=SIM,
    ),
    "gaze_observations": p.GazeObservationBatch(
        observations=[
            p.GazeObservation(
                observation_id="gz-100",
                t_browser_frame_ms=3500.0,
                t_browser_processed_ms=3512.0,
                measurement_kind="screen_gaze",
                calibration_id="cal-1",
                valid=True,
                invalid_reasons=[],
                video_point=p.NormalisedPoint(x=1.3, y=0.4),
                inside_video=False,
                model_confidence=0.7,
            ),
            p.GazeObservation(
                observation_id="gz-101",
                t_browser_frame_ms=3600.0,
                t_browser_processed_ms=3611.0,
                measurement_kind="screen_gaze",
                calibration_id="cal-1",
                valid=False,
                invalid_reasons=["face_not_detected"],
                video_point=None,
                inside_video=None,
                model_confidence=None,
            ),
        ],
        provenance=SIM,
    ),
    "gaze_calibration": p.GazeCalibration(
        calibration_id="cal-1",
        status="valid",
        measurement_kind="screen_gaze",
        method="9-point fit, 4 held-out",
        fit_points=9,
        held_out_points=4,
        held_out_error_norm=0.08,
        viewport_css_px=RECT,
        video_rect_css_px=p.CssRect(x=100, y=80, width=960, height=540),
        invalidated_reason=None,
        t_browser_ms=2000.0,
        provenance=SIM,
    ),
    "review_candidate": p.ReviewCandidate(
        event_id="evt-1",
        detector=DETECTOR,
        mode="both",
        evidence=p.BackendInterval(start_backend_ms=52000.0, end_backend_ms=56000.0),
        decision_backend_ms=56200.0,
        eligibility_epoch=4,
        contributing_signals=SIGNALS,
        provenance=SIM,
    ),
    "review_bookmark": BOOKMARK,
    "manual_bookmark": p.ManualBookmark(
        bookmark_id="manual-1", video_id="video-fixture", media_time_s=120.5, t_browser_ms=9000.0
    ),
    "candidate_rejected": p.CandidateRejected(
        event_id="evt-2", reason="crosses_boundary", detail="evidence spans a seek at segment seg-2 end"
    ),
    "user_feedback": p.UserFeedback(
        feedback_id="fb-1",
        bookmark_id="bm-evt-1",
        action="rated_useful",
        t_browser_ms=9500.0,
        media_time_s=40.0,
    ),
    "sensor_status": SENSORS,
}


def valid_wire(msg_type: str) -> dict[str, Any]:
    session = None if msg_type in ("client_hello",) else "ses-fixture"
    msg = envelope(msg_type, PAYLOADS[msg_type], message_id=f"msg-{msg_type}", session_id=session, seq=3)
    out: dict[str, Any] = json.loads(dumps(msg))
    return out


def mutate(msg_type: str, path: list[str | int], value: Any, *, delete: bool = False) -> str:
    obj = valid_wire(msg_type)
    target: Any = obj
    for key in path[:-1]:
        target = target[key]
    if delete:
        del target[path[-1]]
    else:
        target[path[-1]] = value
    return json.dumps(obj)


def invalid_cases() -> dict[str, dict[str, Any]]:
    pb = json.dumps(valid_wire("playback_state"))
    cases: dict[str, tuple[str, str, str, str]] = {
        "not-json": ("Truncated JSON", "invalid_json", "structural", pb[:40]),
        "nan-media-time": (
            "NaN is not valid JSON and never a valid measurement",
            "invalid_json",
            "structural",
            pb.replace('"mediaTimeS": 42.0', '"mediaTimeS": NaN'),
        ),
        "unknown-version": (
            "Unknown schema version is rejected with a readable error",
            "schema_version_mismatch",
            "structural",
            mutate("playback_state", ["schemaVersion"], "0.2.0"),
        ),
        "unknown-type": (
            "Unknown message type",
            "unknown_type",
            "structural",
            mutate("heartbeat", ["type"], "focus_meter"),
        ),
        "missing-field": (
            "Required field missing (playbackRate)",
            "invalid_message",
            "structural",
            mutate("playback_state", ["payload", "playbackRate"], None, delete=True),
        ),
        "extra-field": (
            "Unknown fields are rejected (e.g. an invented focus percentage)",
            "invalid_message",
            "structural",
            mutate("review_candidate", ["payload", "focusPercent"], 87),
        ),
        "string-number": (
            "Numbers must be JSON numbers, not strings",
            "invalid_message",
            "structural",
            mutate("playback_state", ["payload", "mediaTimeS"], "42"),
        ),
        "negative-media-time": (
            "Media time cannot be negative",
            "invalid_message",
            "structural",
            mutate("playback_state", ["payload", "mediaTimeS"], -1.0),
        ),
        "zero-playback-rate": (
            "Playback rate must be > 0",
            "invalid_message",
            "structural",
            mutate("playback_state", ["payload", "playbackRate"], 0),
        ),
        "playing-without-segment": (
            "state 'playing' requires a segmentId",
            "invalid_message",
            "semantic",
            mutate("playback_state", ["payload", "segmentId"], None),
        ),
        "eeg-null-without-reason": (
            "A missing EEG feature value must carry a missingReason (missing is never zero)",
            "invalid_message",
            "semantic",
            mutate("eeg_features", ["payload", "features", 1, "missingReason"], None),
        ),
        "interval-reversed": (
            "Evidence interval end before start",
            "invalid_message",
            "semantic",
            mutate("review_candidate", ["payload", "evidence", "endBackendMs"], 1.0),
        ),
        "decision-before-evidence-end": (
            "A decision cannot precede the end of its evidence",
            "invalid_message",
            "semantic",
            mutate("review_candidate", ["payload", "decisionBackendMs"], 55000.0),
        ),
        "gaze-invalid-with-point": (
            "Invalid gaze observations must not carry a point",
            "invalid_message",
            "semantic",
            mutate("gaze_observations", ["payload", "observations", 1, "videoPoint"], {"x": 0.5, "y": 0.5}),
        ),
        "candidate-mode-mismatch": (
            "mode 'both' needs both EEG and gaze contributions",
            "invalid_message",
            "semantic",
            mutate("review_candidate", ["payload", "mode"], "gaze_only"),
        ),
        "bookmark-bad-id": (
            "Identifiers use a restricted character set",
            "invalid_message",
            "structural",
            mutate("review_bookmark", ["payload", "bookmarkId"], "../../etc"),
        ),
    }
    return {
        name: {"description": d, "expectedCode": code, "layer": layer, "raw": raw}
        for name, (d, code, layer, raw) in cases.items()
    }


def render() -> dict[Path, str]:
    files: dict[Path, str] = {}
    for msg_type in MESSAGES:
        files[OUT / "valid" / f"{msg_type}.json"] = json.dumps(valid_wire(msg_type), indent=2) + "\n"
    for name, case in invalid_cases().items():
        files[OUT / "invalid" / f"{name}.json"] = json.dumps(case, indent=2) + "\n"
    return files


def main() -> int:
    files = render()
    if "--check" in sys.argv:
        stale = [f for f, text in files.items() if not f.exists() or f.read_text() != text]
        for d in ("valid", "invalid"):
            extra = {f for f in (OUT / d).glob("*.json")} - set(files)
            stale.extend(sorted(extra))
        if stale:
            for f in stale:
                print(f"out of date: {f.relative_to(ROOT)}", file=sys.stderr)
            print("run `npm run contracts:generate`", file=sys.stderr)
            return 1
        print("fixtures up to date")
        return 0
    for f, text in files.items():
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text)
    print(f"wrote {len(files)} fixture files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
