import copy

import pytest

from evaluation.realtime import AttentionLabel, LiveEvaluation


def frame(index=0, end=2.0, score=70):
    return {
        "frame_index": index,
        "window_start_timestamp": end - 1.996,
        "window_end_timestamp": end,
        "sample_indices": (index * 125, index * 125 + 499),
        "preprocessed_metadata": {"sampling_frequency_hz": 250},
        "evaluation_quality": {"whole_window": True, "usable": True},
        "features": {"test_feature": {"value": 0.4, "valid": True}},
        "prediction": {"attention_score": score, "valid": True, "model_type": "test_model"},
        "prediction_valid": True,
    }


def monitor(**kwargs):
    return LiveEvaluation(session_id="test", started_s=100, model_target="lecture_attention", **kwargs)


def observe(evaluator, value=None, now=102.1, mapped=102):
    return evaluator.observe(value or frame(), now_s=now, mapped_end_s=mapped, clock_uncertainty_s=0.001)


def test_attention_scores_require_fresh_complete_quality_gated_input():
    evaluator = monitor()
    assert observe(evaluator)["state"] == "attentive"
    assert observe(evaluator, frame(1, 2.5, 20), 102.6, 102.5)["state"] == "inattentive"
    assert evaluator.report()["frame_accuracy"] is None


@pytest.mark.parametrize(
    "mutation,reason",
    [
        (lambda f: f.pop("evaluation_quality"), "whole_window_quality_unusable_or_missing"),
        (lambda f: f["evaluation_quality"].update(usable=False), "whole_window_quality_unusable_or_missing"),
        (lambda f: f["features"]["test_feature"].update(value=float("nan")), "features_unavailable"),
        (lambda f: f["prediction"].update(model_type="stub"), "attention_model_unavailable"),
        (lambda f: f["prediction"].update(attention_score=float("inf")), "attention_model_unavailable"),
        (lambda f: f.update(sample_indices=(0, 400)), "invalid_window"),
    ],
)
def test_invalid_evidence_never_becomes_inattention(mutation, reason):
    value = frame()
    mutation(value)
    result = observe(monitor(), value)
    assert result["state"] == "unknown" and result["attention_score"] is None
    assert reason in result["reasons"]


def test_workload_target_cannot_become_attention():
    evaluator = LiveEvaluation(session_id="workload", started_s=100, model_target="mental_arithmetic_vs_rest")
    assert observe(evaluator)["state"] == "unknown"


def test_clock_mapping_future_stale_and_duplicate_windows():
    assert "clock_unmapped_or_uncertain" in observe(monitor(), mapped=None)["reasons"]
    assert "future_window" in observe(monitor(), mapped=103)["reasons"]
    assert "stale_window" in observe(monitor(), mapped=100)["reasons"]
    evaluator = monitor()
    observe(evaluator)
    assert "duplicate_or_out_of_order" in observe(evaluator)["reasons"]


def test_stall_transition_and_recovery_without_reusing_previous_score():
    evaluator = monitor()
    observe(evaluator)
    status = evaluator.poll(103.2)
    assert status["state"] == "unknown" and status["attention_score"] is None
    assert evaluator.poll(103.3) is None
    observe(evaluator, frame(1, 3.5), 103.6, 103.5)
    assert evaluator.poll(104.7)["state"] == "unknown"
    assert monitor().poll(103.1)["state"] == "unknown"


def test_independent_labels_require_full_window_and_report_abstentions():
    evaluator = monitor(labels=[AttentionLabel(0, 3, "inattentive")])
    observe(evaluator, frame(score=20))
    bad = frame(1, 2.5)
    bad["evaluation_quality"]["usable"] = False
    observe(evaluator, bad, 102.6, 102.5)
    observe(evaluator, frame(2, 3.5), 103.6, 103.5)  # straddles label end
    report = evaluator.report()
    assert report["labelled_frames"] == 2
    assert report["labelled_coverage"] == 0.5
    assert report["frame_accuracy"] == 1
    assert report["confusion"]["inattentive->unknown"] == 1
    assert report["live_automatic"] is False


def test_labels_do_not_change_predictions_and_overlap_is_rejected():
    value = frame()
    result = observe(monitor(labels=[AttentionLabel(0, 3, "inattentive")]), copy.deepcopy(value))
    assert result["state"] == observe(monitor(), value)["state"]
    with pytest.raises(ValueError, match="overlap"):
        monitor(labels=[AttentionLabel(0, 3, "attentive"), AttentionLabel(2, 4, "unknown")])


def test_decreasing_clock_is_rejected():
    evaluator = monitor()
    observe(evaluator)
    with pytest.raises(ValueError, match="monotonic"):
        evaluator.poll(101)


def test_timing_storage_is_bounded():
    evaluator = monitor()
    for i in range(4200):
        end = 2 + i * 0.5
        observe(evaluator, frame(i, end), 100 + end + 0.1, 100 + end)
    assert len(evaluator.ages) == len(evaluator.intervals) == 4096


def test_quality_retains_bad_early_batch_until_it_leaves_window():
    np = pytest.importorskip("numpy")
    pytest.importorskip("scipy")
    from eeg.acquisition.base_device import SampleBatch
    from eeg.processing.signal_preprocessor import EEGPreprocessor
    from evaluation.realtime_stream import WindowQuality

    tracker = WindowQuality(EEGPreprocessor(bandpass=None), warmup_s=0)
    for start in range(0, 1000, 125):
        indices = np.arange(start, start + 125)
        samples = np.sin(indices / 4)[:, None]
        if start == 0:
            samples[2, 0] = float("nan")
        tracker.process(SampleBatch(samples, indices / 250, indices, ("Fz",), 250, "uV"))
        if start == 375:
            result = tracker.annotate(frame())
            assert result["evaluation_quality"] == {
                "whole_window": True,
                "usable": False,
                "warmup_complete": True,
                "scope": "basic_checks_only",
            }
    assert tracker.annotate(frame(4))["evaluation_quality"]["usable"] is True


def test_paced_owner_pipeline_emits_live_frames_and_cleans_up():
    pytest.importorskip("scipy")
    from evaluation.realtime_stream import mock_session, run_session

    session = mock_session()
    rows = []
    report = run_session(session, duration_s=1.6, window_s=0.5, update_s=0.25, warmup_s=0, emit=rows.append)
    assert report["run_error"] is None
    assert report["source_kind"] == "synthetic"
    assert report["counts"]["frames"] >= 3
    assert report["counts"]["unknown"] == report["counts"]["frames"]
    assert 100 < report["update_interval_p95_ms"] < 700
    assert report["frame_accuracy"] is None
    assert not session.device.get_device_info()["connected"]
    assert all(row["attention_score"] is None for row in rows[:-1])


def test_window_gap_resets_quality_and_warmup():
    np = pytest.importorskip("numpy")
    pytest.importorskip("scipy")
    from eeg.acquisition.base_device import SampleBatch
    from eeg.processing.signal_preprocessor import EEGPreprocessor
    from evaluation.realtime_stream import WindowQuality

    tracker = WindowQuality(EEGPreprocessor(bandpass=None), warmup_s=1)
    for start in (0, 125, 500, 625, 750, 875):
        indices = np.arange(start, start + 125)
        tracker.process(SampleBatch(np.sin(indices / 4)[:, None], indices / 250, indices, ("Fz",), 250, "uV"))
    quality = tracker.annotate(frame(4))["evaluation_quality"]
    assert quality["whole_window"] and not quality["usable"] and not quality["warmup_complete"]


def test_supplied_experimental_classifier_runs_in_owner_pipeline():
    pytest.importorskip("scipy")
    from eeg.realtime.feature_extractor import EEGFeatureExtractor
    from eeg.realtime.feature_registry import FeatureRegistry
    from evaluation.realtime_stream import mock_session, run_session

    class TestClassifier:
        def predict(self, features):
            # Fixed synthetic test output, never a real attention algorithm.
            return {"model_type": "synthetic_test", "valid": True, "attention_score": 75.0}

    registry = FeatureRegistry()
    registry.register("synthetic_test", lambda *args: 1.0)
    session = mock_session()
    session.feature_extractor = EEGFeatureExtractor(registry)
    session.classifier, session.model_target = TestClassifier(), "lecture_attention"
    rows = []
    report = run_session(session, duration_s=1.1, window_s=0.5, update_s=0.25, warmup_s=0, emit=rows.append)
    assert report["run_error"] is None
    assert report["counts"]["attentive"] >= 2
    assert report["frame_accuracy"] is None
    assert not session.device.get_device_info()["streaming"]


def test_device_failure_is_reported_and_disconnected():
    pytest.importorskip("scipy")
    from evaluation.realtime_stream import mock_session, run_session

    session = mock_session()

    def fail(*args):
        raise RuntimeError("scripted disconnect")

    session.device.get_samples = fail
    report = run_session(session, duration_s=0.5, emit=lambda row: None)
    assert "scripted disconnect" in report["run_error"]
    assert not session.device.get_device_info()["connected"]


def test_posthoc_labels_match_live_metrics_without_changing_predictions():
    from evaluation.realtime_labels import score_journal

    labels = [AttentionLabel(0, 3, "inattentive")]
    evaluator = monitor(labels=labels)
    rows = [observe(evaluator, frame(score=20)), observe(evaluator, frame(1, 2.5), 102.6, 102.5)]
    original = copy.deepcopy(rows)
    report = score_journal(iter(rows), session_id="test", labels=labels)
    assert report["frame_accuracy"] == evaluator.report()["frame_accuracy"] == 0.5
    assert rows == original
    with pytest.raises(ValueError, match="session_id"):
        score_journal(iter(rows), session_id="other", labels=labels)


def test_label_boundaries_include_clock_uncertainty_and_bad_features_are_json_safe():
    import json

    evaluator = monitor(labels=[AttentionLabel(0, 2.004, "attentive")])
    value = frame()
    value["features"]["test_feature"]["value"] = float("nan")
    result = observe(evaluator, value)
    assert result["independent_label"] is None  # mapping uncertainty crosses the end
    json.dumps(result, allow_nan=False)


def test_numpy_classifier_output_is_json_safe():
    import json

    np = pytest.importorskip("numpy")
    value = frame(score=np.float32(75))
    value["features"]["test_feature"]["value"] = np.float32(.5)
    result = observe(monitor(), value)
    assert result["state"] == "attentive"
    json.dumps(result, allow_nan=False)
