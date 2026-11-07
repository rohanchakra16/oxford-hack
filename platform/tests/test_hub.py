"""Hub behaviour through the real wire format, with a synthetic browser, a non-zero clock offset,
network jitter and a controllable clock (no sleeps). All data is synthetic."""

from __future__ import annotations

import json

import pytest

from oxford_hack.contracts import payloads as p
from oxford_hack.harness.sim import SIM_GAZE, Sim, SimBrowser, SimPlayer
from oxford_hack.harness.synthetic import SIM_INFERENCE, QualityEvent
from oxford_hack.session.hub import Hub, HubSettings, IdFactory
from oxford_hack.timing.clock import ManualClock

from .conftest import make_hub_factory


def started(
    sim: Sim, *, eeg: bool = True, gaze: bool = False, run_kind: str = "simulated", client: str = "client-1"
) -> tuple[SimBrowser, SimPlayer]:
    b = sim.browser(client)
    b.connect()
    sim.run(1_000)  # clock-sync burst
    b.start_session("video-a", eeg=eeg, gaze=gaze, run_kind=run_kind)
    sim.run(200)
    assert b.session_id is not None
    return b, SimPlayer(b, "video-a")


def candidate(
    event_id: str,
    start: float,
    end: float,
    decision: float | None = None,
    mode: str = "eeg_only",
    run_kind: str = "simulated",
) -> p.ReviewCandidate:
    signals = {"eeg_only": ["eeg"], "gaze_only": ["gaze"], "both": ["eeg", "gaze"]}[mode]
    return p.ReviewCandidate(
        event_id=event_id,
        detector=p.DetectorInfo(detector_id="test", detector_version="0", config_version="0"),
        mode=mode,  # type: ignore[arg-type]
        evidence=p.BackendInterval(start_backend_ms=start, end_backend_ms=end),
        decision_backend_ms=decision if decision is not None else end + 100,
        eligibility_epoch=None,
        contributing_signals=[
            p.ContributingSignal(signal=s, window_ids=[], scores=[])  # type: ignore[arg-type]
            for s in signals
        ],
        provenance=p.Provenance(run_kind=run_kind, producer="test", producer_version="0"),  # type: ignore[arg-type]
    )


def bookmarks(b: SimBrowser) -> list[dict]:  # type: ignore[type-arg]
    return [m["payload"] for m in b.of_type("review_bookmark")]


def rejections(b: SimBrowser) -> list[str]:
    return [m["payload"]["reason"] for m in b.of_type("candidate_rejected")]


# ------------------------------------------------------------------ mapping end to end


@pytest.mark.parametrize(
    "offset", [-9_000.0, 123_456.7, 3.3]
)  # browser clock = backend + offset, always >= 0
def test_candidate_maps_to_expected_media_time_with_clock_offset(offset: float) -> None:
    sim = Sim(make_hub_factory(period_ms=1e12), jitter_ms=8.0)
    b = sim.browser(offset_ms=offset)
    b.connect()
    sim.run(1_000)
    b.start_session("video-a")
    sim.run(200)
    player = SimPlayer(b, "video-a")
    player.media_s = 120.0
    t0 = sim.clock.now_ms()
    player.play()
    sim.run(20_000)
    session_id = b.session_id
    sim.hub.ingest_internal(candidate("evt-1", t0 + 8_000, t0 + 12_000), session_id=session_id)
    sim.run(500)
    [bm] = bookmarks(b)
    tol = bm["mappingUncertaintyMs"] / 1000 + 0.01
    assert bm["evidenceMedia"]["startMediaS"] == pytest.approx(128.0, abs=tol)
    assert bm["evidenceMedia"]["endMediaS"] == pytest.approx(132.0, abs=tol)
    assert bm["suggestedMediaS"] == pytest.approx(126.0, abs=tol)  # 2 s lead-in
    assert bm["runKind"] == "simulated" and bm["source"] == "experimental_eeg"
    assert bm["bookmarkId"] == "bm-evt-1" and bm["transcriptContext"] is None


def test_duplicate_events_create_one_bookmark() -> None:
    sim = Sim(make_hub_factory(period_ms=1e12))
    b, player = started(sim)
    t0 = sim.clock.now_ms()
    player.play()
    sim.run(15_000)
    c = candidate("evt-dup", t0 + 5_000, t0 + 9_000)
    for _ in range(3):
        sim.hub.ingest_internal(c, session_id=b.session_id)
    sim.run(300)
    assert len(bookmarks(b)) == 1
    assert rejections(b) == ["duplicate", "duplicate"]


def test_delayed_candidate_is_pending_then_mapped_and_stale_one_rejected() -> None:
    sim = Sim(make_hub_factory(period_ms=1e12))
    b, player = started(sim)
    t0 = sim.clock.now_ms()
    player.play()
    sim.run(5_000)
    now = sim.clock.now_ms()
    # Evidence ends 'now': telemetry has not yet confirmed playback continued -> pending.
    sim.hub.ingest_internal(candidate("evt-tail", now - 3_000, now), session_id=b.session_id)
    assert bookmarks(b) == []
    sim.run(2_000)  # heartbeats arrive
    assert [x["eventId"] for x in bookmarks(b)] == ["evt-tail"]
    # A candidate decided too long ago is rejected.
    sim.run(40_000)
    sim.hub.ingest_internal(
        candidate("evt-old", t0 + 1_000, t0 + 3_000, decision=t0 + 3_100), session_id=b.session_id
    )
    sim.run(100)
    assert rejections(b) == ["too_old"]


def test_pending_candidate_rejected_when_playback_stops_before_its_end() -> None:
    sim = Sim(make_hub_factory(period_ms=1e12))
    b, player = started(sim)
    player.play()
    sim.run(5_000)
    now = sim.clock.now_ms()
    sim.hub.ingest_internal(candidate("evt-x", now - 2_000, now + 500), session_id=b.session_id)
    sim.run(100)
    player.pause()
    sim.run(500)
    assert rejections(b) == ["crosses_boundary"]


def test_pending_candidate_times_out_without_telemetry() -> None:
    sim = Sim(make_hub_factory(period_ms=1e12))
    b, player = started(sim)
    player.play()
    sim.run(5_000)
    player.heartbeat_ms = 1e9  # telemetry stops (e.g. throttled tab)
    player._hb_token += 1
    now = sim.clock.now_ms()
    sim.hub.ingest_internal(candidate("evt-y", now - 1_000, now + 2_000), session_id=b.session_id)
    sim.run(5_000)
    assert rejections(b) == ["stale_telemetry"]


def test_seek_resets_eligibility_and_placeholder_waits_for_full_window() -> None:
    sim = Sim(make_hub_factory(period_ms=5_000))
    b, player = started(sim)
    player.media_s = 10.0
    player.play()
    sim.run(12_000)
    player.seek(300.0)
    sim.run(3_000)
    player.seek(30.0)
    sim.run(15_000)
    marks = bookmarks(b)
    assert marks, "placeholder should emit after a full window"
    seg_starts = {
        seg.segment_id: seg.start_browser_ms for seg in sim.hub.sessions[b.session_id].timeline.segments
    }  # type: ignore[index]
    for bm in marks:
        assert bm["segmentId"] in seg_starts
    # No bookmark from the 3 s segment at 300 s: it never had a complete 4 s window.
    assert not [bm for bm in marks if 300 <= bm["evidenceMedia"]["startMediaS"] < 310]
    elig = [m["payload"] for m in b.of_type("playback_eligibility")]
    assert [e["reason"] for e in elig].count("seeking") >= 2
    assert all(e["epoch"] == i + 1 for i, e in enumerate(elig))


def test_speed_change_through_session() -> None:
    sim = Sim(make_hub_factory(period_ms=1e12))
    b, player = started(sim)
    player.play()
    sim.run(4_000)
    t_rate = sim.clock.now_ms()
    media_at_rate = player.position()
    player.set_rate(2.0)
    sim.run(10_000)
    sim.hub.ingest_internal(candidate("evt-r", t_rate + 3_000, t_rate + 5_000), session_id=b.session_id)
    sim.run(200)
    [bm] = bookmarks(b)
    assert bm["evidenceMedia"]["startMediaS"] == pytest.approx(media_at_rate + 6.0, abs=0.05)
    assert bm["evidenceMedia"]["endMediaS"] == pytest.approx(media_at_rate + 10.0, abs=0.05)


# ------------------------------------------------------------------ sessions and isolation


def test_obsolete_session_and_video_change_in_flight() -> None:
    sim = Sim(make_hub_factory(period_ms=1e12))
    b, player = started(sim)
    player.play()
    sim.run(5_000)
    old = b.session_id
    now = sim.clock.now_ms()
    sim.hub.ingest_internal(candidate("evt-flight", now - 2_000, now + 1_000), session_id=old)  # pending
    b.send("session_end", p.SessionEnd(reason="video_changed"))
    sim.run(200)
    assert rejections(b) == ["obsolete_session"]
    b.start_session("video-b")
    sim.run(200)
    assert b.session_id != old
    sim.hub.ingest_internal(candidate("evt-late", now - 2_000, now - 1_000), session_id=old)
    assert sim.hub.counters["candidate_obsolete_session"] == 1
    b.send(
        "manual_bookmark",
        p.ManualBookmark(bookmark_id="m1", video_id="video-a", media_time_s=1.0, t_browser_ms=b.now()),
        session_id=old,
    )
    sim.run(100)
    codes = [m["payload"]["code"] for m in b.of_type("error")]
    assert "obsolete_session" in codes
    b.send(
        "manual_bookmark",
        p.ManualBookmark(bookmark_id="m2", video_id="video-a", media_time_s=1.0, t_browser_ms=b.now()),
    )
    sim.run(100)
    assert [m["payload"]["code"] for m in b.of_type("error")][-1] == "video_mismatch"


def test_out_of_order_telemetry_rejected_without_closing() -> None:
    sim = Sim(make_hub_factory())
    b, _ = started(sim)
    state = p.PlaybackState(
        video_id="video-a",
        segment_id=None,
        event="pause",
        state="paused",
        t_browser_ms=b.now(),
        media_time_s=1.0,
        playback_rate=1.0,
        media_duration_s=None,
        telemetry_seq=5,
    )
    b.send("playback_state", state)
    b.send("playback_state", state.model_copy(update={"telemetry_seq": 4}))
    sim.run(200)
    assert [m["payload"]["code"] for m in b.of_type("error")] == ["out_of_order"]
    assert b.conn is not None


def test_invalid_and_incompatible_messages() -> None:
    sim = Sim(make_hub_factory())
    b, _ = started(sim)
    good = json.loads(json.dumps(b.received[0]))
    b.send_raw('{"schemaVersion":"0.1.0","type":"playback_state"}')
    sim.run(100)
    assert b.of_type("error")[-1]["payload"]["code"] == "invalid_message"
    assert b.conn is not None  # non-fatal
    good["schemaVersion"] = "9.9.9"
    b.send_raw(json.dumps(good))
    sim.run(100)
    err = b.of_type("error")[-1]["payload"]
    assert err["code"] == "schema_version_mismatch" and err["fatal"] is True
    assert b.closes[-1][0] == 4400


def test_manual_bookmark_and_feedback() -> None:
    sim = Sim(make_hub_factory())
    b, _ = started(sim)
    for _ in range(2):
        b.send(
            "manual_bookmark",
            p.ManualBookmark(
                bookmark_id="manual-1", video_id="video-a", media_time_s=42.0, t_browser_ms=b.now()
            ),
        )
    sim.run(100)
    assert [x["bookmarkId"] for x in bookmarks(b)] == ["manual-1"]
    assert bookmarks(b)[0]["source"] == "manual" and bookmarks(b)[0]["evidence"] is None
    b.send(
        "user_feedback",
        p.UserFeedback(
            feedback_id="f1", bookmark_id="manual-1", action="replay", t_browser_ms=b.now(), media_time_s=40.0
        ),
    )
    b.send(
        "user_feedback",
        p.UserFeedback(
            feedback_id="f2", bookmark_id="nope", action="dismiss", t_browser_ms=b.now(), media_time_s=None
        ),
    )
    sim.run(100)
    session = sim.hub.sessions[b.session_id]  # type: ignore[index]
    assert [f.feedback_id for f in session.feedback] == ["f1"]
    assert b.of_type("error")[-1]["payload"]["code"] == "invalid_message"


def test_live_session_without_detector_is_manual_only() -> None:
    def factory(clock: ManualClock) -> Hub:
        return Hub(clock, ids=IdFactory("live"), backend_instance_id="be-live")

    sim = Sim(factory)
    b, player = started(sim, run_kind="live")
    config = b.of_type("session_config")[0]["payload"]
    assert config["detector"] is None
    assert config["modePolicy"] == {
        "both": "manual_only",
        "eegOnly": "manual_only",
        "gazeOnly": "manual_only",
    }
    status = b.of_type("sensor_status")[-1]["payload"]
    assert status["eeg"]["state"] == "unavailable" and status["automaticSuggestions"] is False
    player.play()
    sim.run(5_000)
    now = sim.clock.now_ms()
    sim.hub.ingest_internal(
        candidate("evt-live", now - 3_000, now - 1_000, run_kind="live"), session_id=b.session_id
    )
    sim.run(100)
    assert rejections(b) == ["mode_not_automatic"]


def test_simulated_data_never_enters_a_live_session() -> None:
    def factory(clock: ManualClock) -> Hub:
        return Hub(clock, ids=IdFactory("iso"), backend_instance_id="be-iso")

    sim = Sim(factory)
    b, _ = started(sim, run_kind="live", gaze=True)
    b.send(
        "gaze_observations",
        p.GazeObservationBatch(
            observations=[
                p.GazeObservation(
                    observation_id="g1",
                    t_browser_frame_ms=b.now(),
                    t_browser_processed_ms=b.now(),
                    measurement_kind="screen_gaze",
                    calibration_id=None,
                    valid=False,
                    invalid_reasons=["calibration_missing"],
                    video_point=None,
                    inside_video=None,
                    model_confidence=None,
                )
            ],
            provenance=SIM_GAZE,
        ),
    )
    sim.run(100)
    assert b.of_type("error")[-1]["payload"]["code"] == "invalid_message"


# ------------------------------------------------------------------ sensors


def test_sensor_loss_and_recovery_changes_mode_not_bookmarks() -> None:
    script = (QualityEvent(10_000, 16_000, "dropout"), QualityEvent(20_000, 24_000, "flatline"))
    sim = Sim(make_hub_factory(period_ms=1e12, script=script))
    b, _ = started(sim)
    sim.run(30_000)
    states = [
        (m["payload"]["eeg"]["state"], m["payload"]["mode"], m["payload"]["automaticSuggestions"])
        for m in b.of_type("sensor_status")
    ]
    compact = [s for i, s in enumerate(states) if i == 0 or s != states[i - 1]]
    assert ("lost", "manual_only", False) in compact
    assert ("degraded", "manual_only", False) in compact
    assert compact[-1] == ("ok", "eeg_only", True)
    assert compact.index(("lost", "manual_only", False)) < compact.index(("degraded", "manual_only", False))
    assert bookmarks(b) == []  # sensor problems are not lapses


def test_gaze_status_from_calibration_and_coverage() -> None:
    sim = Sim(make_hub_factory(period_ms=1e12))
    b, _ = started(sim, eeg=False, gaze=True)
    rect = p.CssRect(x=0, y=0, width=100, height=100)

    def obs(i: int, valid: bool) -> p.GazeObservation:
        return p.GazeObservation(
            observation_id=f"g{i}",
            t_browser_frame_ms=b.now(),
            t_browser_processed_ms=b.now(),
            measurement_kind="screen_gaze",
            calibration_id="cal-1",
            valid=valid,
            invalid_reasons=[] if valid else ["face_not_detected"],
            video_point=p.NormalisedPoint(x=0.5, y=0.5) if valid else None,
            inside_video=True if valid else None,
            model_confidence=None,
        )

    b.send("gaze_observations", p.GazeObservationBatch(observations=[obs(0, True)], provenance=SIM_GAZE))
    sim.run(100)
    assert b.of_type("sensor_status")[-1]["payload"]["gaze"]["reasons"] == ["calibration missing"]
    b.send(
        "gaze_calibration",
        p.GazeCalibration(
            calibration_id="cal-1",
            status="valid",
            measurement_kind="screen_gaze",
            method="test",
            fit_points=9,
            held_out_points=3,
            held_out_error_norm=0.05,
            viewport_css_px=rect,
            video_rect_css_px=rect,
            invalidated_reason=None,
            t_browser_ms=b.now(),
            provenance=SIM_GAZE,
        ),
    )
    for i in range(1, 6):
        b.send("gaze_observations", p.GazeObservationBatch(observations=[obs(i, True)], provenance=SIM_GAZE))
        sim.run(200)
    assert b.of_type("sensor_status")[-1]["payload"]["gaze"]["state"] == "ok"
    sim.run(3_000)  # stream stops
    last = b.of_type("sensor_status")[-1]["payload"]
    assert last["gaze"]["state"] == "lost" and last["mode"] == "manual_only"


# ------------------------------------------------------------------ connection lifecycle


def test_reconnect_resumes_surviving_session_with_snapshot() -> None:
    sim = Sim(make_hub_factory(period_ms=5_000))
    b, player = started(sim)
    player.play()
    sim.run(15_000)
    before = {x["bookmarkId"] for x in bookmarks(b)}
    assert before
    sid = b.session_id
    b.disconnect()
    sim.run(5_000)
    b.connect(resume=True)
    sim.run(500)
    hello = b.of_type("server_hello")[-1]["payload"]
    assert hello["resumeOutcome"] == "resumed" and hello["sessionId"] == sid
    snap = b.of_type("session_snapshot")[-1]["payload"]
    assert {x["bookmarkId"] for x in snap["bookmarks"]} >= before
    seqs = [m["seq"] for m in b.received if m["sessionId"] == sid]
    assert seqs == sorted(seqs)  # session seq continues across connections


def test_backend_restart_is_distinguished_from_reconnect() -> None:
    factory = make_hub_factory()
    sim = Sim(factory)
    b, _ = started(sim)
    sim.restart_hub(factory)
    sim.run(50)
    assert b.closes[-1][0] == 1006
    b.connect(resume=True)
    sim.run(300)
    assert b.of_type("server_hello")[-1]["payload"]["resumeOutcome"] == "backend_restarted"
    assert b.session_id is None


def test_session_expires_after_grace_period_and_cannot_resume() -> None:
    settings = HubSettings(session_grace_ms=10_000)
    sim = Sim(make_hub_factory(settings=settings))
    b, _ = started(sim)
    sid = b.session_id
    b.disconnect()
    sim.run(11_000)
    assert sid in sim.hub.ended_sessions
    b.session_id = sid
    b.connect(resume=True)
    sim.run(200)
    assert b.of_type("server_hello")[-1]["payload"]["resumeOutcome"] == "session_expired"


def test_resume_from_another_page_is_refused() -> None:
    sim = Sim(make_hub_factory())
    b, _ = started(sim)
    other = sim.browser("client-2")
    other.session_id, other.backend_instance_id = b.session_id, b.backend_instance_id
    other.connect(resume=True)
    sim.run(200)
    assert other.of_type("server_hello")[-1]["payload"]["resumeOutcome"] == "session_unknown"


def test_silent_client_is_disconnected_by_heartbeat_timeout() -> None:
    sim = Sim(make_hub_factory())
    b, _ = started(sim)
    b.answer_pings = False
    b.send_raw = lambda text: None  # type: ignore[method-assign]
    sim.run(7_000)
    assert b.closes and b.closes[-1] == (4000, "heartbeat timeout")
    assert sim.hub.sessions[next(iter(sim.hub.sessions))].conn is None


def test_simulation_is_deterministic() -> None:
    def run() -> list[str]:
        sim = Sim(make_hub_factory(period_ms=5_000, instance=999), seed=11)
        b, player = started(sim)
        player.play()
        sim.run(10_000)
        player.seek(100.0)
        sim.run(20_000)
        return [
            json.dumps({k: v for k, v in m.items() if k != "messageId"}, sort_keys=True)
            for m in b.received
            if m["type"] in ("review_bookmark", "candidate_rejected", "playback_eligibility")
        ]

    first, second = run(), run()
    assert first == second and len(first) > 3


_ = SIM_INFERENCE
