from fastapi.testclient import TestClient

from evaluation.player_api import create_app


def setup(scenario=None, workload=None):
    now = [100.0]
    client = TestClient(
        create_app(clock=lambda: now[0], scenario=scenario, workload=workload)
    )
    snapshot = client.post(
        "/sessions", json={"videoId": "local-test", "durationS": 100}
    ).json()
    sid = snapshot["sessionId"]
    seq = [0]

    def tick(media, state="playing", replaying=False, step=1.0):
        now[0] += step
        seq[0] += 1
        response = client.post(
            f"/sessions/{sid}/tick",
            json={
                "seq": seq[0],
                "mediaS": media,
                "state": state,
                "replaying": replaying,
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
