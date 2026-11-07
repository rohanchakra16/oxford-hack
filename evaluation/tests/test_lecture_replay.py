import json

from evaluation.lecture_replay import (
    FIXTURE,
    MODES,
    interactive,
    mode_config,
    run_replay,
    synthetic_ticks,
    workload_ticks,
)


def test_reproducible_replay_all_viewing_modes_and_30_second_pacing():
    spec = json.loads(FIXTURE.read_text())
    for mode in MODES:
        ticks = synthetic_ticks(spec)
        report, _ = run_replay(ticks, mode_config(mode))
        again, _ = run_replay(ticks, mode_config(mode))
        assert report == again
        assert report["metrics"]["review_segments"] == 4
        assert report["metrics"]["detection_accuracy"] is None
        assert report["metrics"]["false_positive_rate"] is None
        assert all(segment["prototype"] for segment in report["segments"])
        if mode == "normal":
            assert not report["questions"]
        else:
            assert report["metrics"]["question_requests"] == 4
            assert report["metrics"]["minimum_prompt_interval_ms"] >= 30000.0
            if mode == "educational-end":
                assert min(q["requestedBackendMs"] for q in report["questions"]) >= 120000.0


def test_no_loss_and_quality_failure_scenarios_do_not_create_questions():
    for score, unknown in ((0.9, []), (0.0, [{"start_s": 0, "end_s": 30}])):
        ticks = synthetic_ticks(
            {"duration_s": 20, "baseline_score": score, "score_blocks": [], "unknown_blocks": unknown}
        )
        report, _ = run_replay(ticks, mode_config("educational-immediate"))
        assert report["metrics"]["review_segments"] == 0
        assert report["metrics"]["question_requests"] == 0


def test_eegmat_mapping_is_explicit_hypothetical_demo_and_has_no_reference_accuracy():
    payload = {
        "target": "mental_arithmetic_vs_rest",
        "live_automatic": False,
        "windows": [
            {"start_device_s": float(t), "end_device_s": t + 4.0, "prediction": {"state": "ok", "score": 0.1}}
            for t in range(10, 42, 4)
        ],
    }
    report, _ = run_replay(workload_ticks(payload), mode_config("educational-end"))
    assert report["source"] == ["eegmat_demo"]
    assert report["metrics"]["detection_accuracy"] is None
    assert report["metrics"]["review_segments"] == 1
    assert report["questions"][0]["affectedRange"] == {"startMediaS": 0.0, "endMediaS": 32.0}


def test_terminal_answers_dismisses_and_replays_with_idempotent_presentation(monkeypatch, capsys):
    ticks = synthetic_ticks(json.loads(FIXTURE.read_text()))
    _, engine = run_replay(ticks, mode_config("educational-end"), auto_resolve=False)
    commands = iter(["list", "replay", "complete-replay", "answer An explanation", "next", "dismiss", "quit"])
    monkeypatch.setattr("builtins.input", lambda _: next(commands))
    interactive(engine)
    assert list(engine.questions.states.values()) == ["answered", "dismissed"]
    assert "replay_range" in capsys.readouterr().out
