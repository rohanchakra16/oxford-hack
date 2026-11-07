from fastapi.testclient import TestClient

from evaluation.player_api import create_app


def setup(
    scenario=None, workload=None, *, config=None, combine_gaze=False, duration=100
):
    now = [100.0]
    client = TestClient(
        create_app(
            clock=lambda: now[0], scenario=scenario, workload=workload, config=config
        )
    )
    snapshot = client.post(
        "/sessions",
        json={
            "videoId": "local-test",
            "durationS": duration,
            "combineGaze": combine_gaze,
        },
    ).json()
    sid = snapshot["sessionId"]
    seq = [0]

    def tick(media, state="playing", replaying=False, step=1.0, gaze=None, rate=1):
        now[0] += step
        seq[0] += 1
        response = client.post(
            f"/sessions/{sid}/tick",
            json={
                "seq": seq[0],
                "mediaS": media,
                "state": state,
                "replaying": replaying,
                "gaze": gaze,
                "playbackRate": rate,
            },
        )
        assert response.status_code == 200, response.text
        return response.json()

    return client, sid, tick


def test_conservative_player_bridge_ignores_brief_dip_then_saves_original_media_time():
    _, _, tick = setup()
    first = None
    for second in range(50):
        result = tick(second)
        if second < 24:
            assert not result["segments"]
        if result["segments"] and first is None:
            first = result
    assert len(result["segments"]) == 1
    segment = result["segments"][0]
    assert 15 <= segment["mediaRange"]["startMediaS"] <= 18
    assert segment["closed"]
    assert first["events"][-1]["type"] == "review_segment"
    assert result["source"] == "synthetic"
    assert result["prototype"] is True


def test_pause_unknown_and_replay_never_accumulate_loss_or_duplicate_bookmarks():
    low = {"baseline_score": 0.05, "score_blocks": [], "unknown_blocks": []}
    _, _, tick = setup(low)
    for second in range(9):
        assert not tick(second)["segments"]
    assert tick(8, "paused")["status"]["state"] == "interrupted"
    for second in range(9, 18):
        assert not tick(second)["segments"]
    for second in range(18, 23):
        result = tick(second)
    assert len(result["segments"]) == 1
    for second in range(4, 23):
        result = tick(second, replaying=True)
        assert result["status"]["state"] == "interrupted"
        assert len(result["segments"]) == 1


def test_unusable_workload_remains_unknown_and_windows_crossing_boundaries_are_covered():
    payload = {
        "target": "mental_arithmetic_vs_rest",
        "live_automatic": False,
        "windows": [
            {
                "start_device_s": t,
                "end_device_s": t + 4,
                "prediction": {"state": "ok", "score": 0.05},
            }
            for t in range(10, 42, 4)
        ],
    }
    _, _, tick = setup(workload=payload)
    tick(0.5)
    for second in range(1, 30):
        result = tick(second + 0.5)
    assert len(result["segments"]) == 1
    assert result["source"] == "eegmat_demo"
    assert tick(33.5)["status"]["level"] == "unknown"


def test_validation_isolation_and_expired_sessions():
    client, sid, tick = setup()
    assert client.get("/health").json()["liveAutomatic"] is False
    assert (
        client.post(
            f"/sessions/{sid}/tick", json={"seq": 0, "mediaS": 101, "state": "playing"}
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/sessions", json={"videoId": "x", "durationS": 100, "live": True}
        ).status_code
        == 422
    )
    tick(0)
    assert (
        client.post(
            f"/sessions/{sid}/tick", json={"seq": 1, "mediaS": 1, "state": "playing"}
        ).json()["events"]
        == []
    )
    client.delete(f"/sessions/{sid}")
    assert (
        client.post(
            f"/sessions/{sid}/tick", json={"seq": 2, "mediaS": 2, "state": "playing"}
        ).status_code
        == 404
    )


def test_conservative_profile_reduces_scripted_nuisance_segments_without_disabling_long_losses():
    from evaluation.lecture_replay import mode_config, run_replay, synthetic_ticks
    from evaluation.player_api import CONSERVATIVE
    from inference.lecture_types import LectureConfig

    conservative = LectureConfig.model_validate_json(CONSERVATIVE.read_text())
    spec = {
        "duration_s": 120,
        "baseline_score": 0.9,
        "score_blocks": [
            {"start_s": 10, "end_s": 18, "score": 0.1},
            {"start_s": 35, "end_s": 48, "score": 0.35},
            {"start_s": 65, "end_s": 95, "score": 0.05},
        ],
    }
    old, _ = run_replay(synthetic_ticks(spec), mode_config("normal"))
    new, _ = run_replay(synthetic_ticks(spec), conservative)
    assert old["metrics"]["review_segments"] == 3
    assert new["metrics"]["review_segments"] == 1
    assert new["metrics"]["false_positive_rate"] is None


def test_eight_second_dwell_keeps_separate_episodes_as_distinct_review_moments():
    scenario = {
        "baseline_score": 0.9,
        "score_blocks": [
            {"start_s": 0, "end_s": 12, "score": 0.05},
            {"start_s": 30, "end_s": 55, "score": 0.05},
        ],
    }
    _, _, tick = setup(scenario)
    # The first usable low estimate is received at media time 1 s.
    for second in range(9):
        assert not tick(second)["segments"]
    first = tick(9)
    assert first["config"]["minimumLossMs"] == 8000.0
    assert len(first["segments"]) == 1
    first_id = first["segments"][0]["segmentId"]
    for second in range(10, 57):
        result = tick(second)
    assert len(result["segments"]) == 2
    assert result["segments"][0]["segmentId"] == first_id
    assert result["segments"][1]["segmentId"] != first_id


def fast_config():
    from inference.lecture_types import LectureConfig

    return LectureConfig(
        smoothing_tau_ms=0,
        minimum_loss_ms=1000,
        recovery_ms=0,
        merge_gap_s=0,
        low_attention_max=0.3,
    )


def gaze_window(outside=0, **overrides):
    return {
        "calibrationId": "cal-test",
        "calibrationValid": True,
        "validFraction": 1,
        "outsideFraction": outside,
        "windowMs": 1000,
        "newestAgeMs": 20,
        "maxGapMs": 70,
        **overrides,
    }


def test_bookmark_cooldown_suppresses_new_flags_but_keeps_detection_records():
    scenario = {
        "baseline_score": 0.9,
        "unknown_blocks": [],
        "score_blocks": [
            {"start_s": 1, "end_s": 4, "score": 0.05},
            {"start_s": 10, "end_s": 35, "score": 0.05},
            {"start_s": 40, "end_s": 44, "score": 0.05},
        ],
    }
    _, _, tick = setup(scenario, config=fast_config())
    for second in range(39):
        result = tick(second)
        if second >= 12:
            assert len(result["segments"]) == 2
            # A suppressed, continuing flag never becomes a delayed bookmark.
            assert len(result["bookmarks"]) == 1
    for second in range(39, 47):
        result = tick(second)
    assert len(result["segments"]) == 3
    assert len(result["bookmarks"]) == 2
    times = [b["firstDetectedBackendMs"] for b in result["bookmarks"]]
    assert times[1] - times[0] >= 30_000
    assert result["bookmarkCooldownS"] == 30


def test_bookmark_cooldown_boundary_is_backend_time_not_media_position():
    low = {"baseline_score": 0.05, "score_blocks": [], "unknown_blocks": []}
    _, _, tick = setup(low, config=fast_config(), duration=200)
    tick(0)
    tick(1)
    first = tick(2)
    assert len(first["bookmarks"]) == 1
    # Seeking far forward cannot bypass the wall-clock cooldown.
    tick(100, "seeking")
    tick(100)
    tick(101)
    assert len(tick(102)["bookmarks"]) == 1
    # A new flag exactly 30 seconds after the first bookmark is allowed.
    tick(130, "seeking", step=23)
    tick(130)
    tick(131)
    result = tick(132)
    assert len(result["segments"]) == 3
    assert len(result["bookmarks"]) == 2
    assert (
        result["bookmarks"][1]["firstDetectedBackendMs"]
        - first["bookmarks"][0]["firstDetectedBackendMs"]
        == 30_000
    )


def test_bookmarks_survive_lecture_end_replay_and_are_session_local():
    low = {"baseline_score": 0.05, "score_blocks": [], "unknown_blocks": []}
    client, _, tick = setup(low, config=fast_config())
    for second in range(5):
        result = tick(second)
    saved = result["bookmarks"][0]["segmentId"]
    ended = tick(100, "ended")
    assert ended["ended"]
    assert ended["bookmarks"][0]["segmentId"] == saved
    replay = tick(1, replaying=True)
    assert replay["ended"] and len(replay["bookmarks"]) == 1
    fresh = client.post("/sessions", json={"videoId": "other", "durationS": 100}).json()
    assert fresh["bookmarks"] == [] and not fresh["ended"]


def test_combined_eeg_gaze_calibrates_then_requires_both_signals():
    scenario = {
        "baseline_score": 0.9,
        "unknown_blocks": [],
        "score_blocks": [{"start_s": 10, "end_s": 40, "score": 0.05}],
    }
    _, _, tick = setup(scenario, config=fast_config(), combine_gaze=True)
    for second in range(10):
        result = tick(second, gaze=gaze_window())
        assert not result["bookmarks"]
    assert result["fusion"]["calibrated"]
    for second in range(10, 20):
        result = tick(second, gaze=gaze_window())
        assert not result["bookmarks"]  # EEG loss alone is below combined threshold.
    for second in range(20, 25):
        result = tick(second, gaze=gaze_window(1))
    assert len(result["bookmarks"]) == 1
    assert result["fusion"]["combinedLoss"] >= 0.7
    assert result["bookmarks"][0]["mediaRange"]["startMediaS"] == 19


def test_combined_missing_poor_or_expired_gaze_is_unknown_not_a_flag():
    scenario = {"baseline_score": 0.9, "score_blocks": [], "unknown_blocks": []}
    _, _, tick = setup(scenario, combine_gaze=True)
    for second in range(10):
        result = tick(second, gaze=gaze_window())
    assert result["fusion"]["calibrated"]
    bad_windows = [
        None,
        gaze_window(1, calibrationValid=False),
        gaze_window(1, validFraction=0.79),
        gaze_window(1, newestAgeMs=251),
        gaze_window(1, maxGapMs=251),
        gaze_window(1, windowMs=100),
    ]
    for second, gaze in enumerate(bad_windows, 10):
        result = tick(second, gaze=gaze)
        assert result["status"]["level"] == "unknown"
        assert result["fusion"]["combinedLoss"] is None
        assert not result["bookmarks"]
