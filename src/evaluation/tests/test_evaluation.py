from pathlib import Path

import pytest
from pydantic import ValidationError

from evaluation.labels import Label, append_label
from evaluation.metrics import Event, event_metrics
from evaluation.splits import Recording, participant_splits, validate_splits


def test_label_data_stays_at_repository_root():
    from evaluation.labels import REPO_ROOT

    assert Path(__file__).resolve().parents[3] == REPO_ROOT
    assert (REPO_ROOT / "AGENTS.md").is_file()


def test_grouped_splits_are_reproducible_and_order_independent():
    rows = [Recording(f"p{i}", f"s{i}-{j}", f"r{i}-{j}") for i in range(10) for j in range(2)]
    result = participant_splits(rows)
    assert result == participant_splits(list(reversed(rows)))
    validate_splits(result)
    assert sum(map(len, result.values())) == len(rows)


def test_participant_leakage_rejected():
    with pytest.raises(ValueError, match="participant_id"):
        validate_splits(
            {
                "train": [Recording("p1", "s1", "r1")],
                "validation": [Recording("p2", "s2", "r2")],
                "test": [Recording("p1", "s3", "r3")],
            }
        )


def test_nested_session_leakage_and_duplicate_recordings_rejected():
    with pytest.raises(ValueError, match="session_id"):
        validate_splits(
            {
                "train": [Recording("p1", "shared", "r1")],
                "validation": [Recording("p2", "s2", "r2")],
                "test": [Recording("p3", "shared", "r3")],
            }
        )
    with pytest.raises(ValueError, match="duplicate"):
        participant_splits(
            [
                Recording("p1", "s1", "r1"),
                Recording("p2", "s2", "r2"),
                Recording("p3", "s3", "r3"),
                Recording("p3", "s3", "r3"),
            ]
        )


def test_too_few_participants_rejected():
    with pytest.raises(ValueError):
        participant_splits([Recording("p1", "s1", "r1")])


def test_matching_finds_maximum_cardinality():
    truth = [Event("r", 0.0, 10.0), Event("r", 10.0, 20.0)]
    predictions = [Event("r", 0.0, 20.0), Event("r", 0.0, 10.0)]
    result = event_metrics(truth, predictions, eligible_duration_ms=1000.0)
    assert result["true_positives"] == 2
    assert result["f1"] == 1.0


def test_duplicate_predictions_are_false_positives():
    event = Event("r", 0.0, 10.0)
    result = event_metrics([event], [event, event], eligible_duration_ms=3_600_000.0)
    assert result["true_positives"] == 1
    assert result["false_positives_per_eligible_hour"] == 1.0


def test_no_matching_across_recordings_and_undefined_metrics():
    result = event_metrics([Event("a", 0.0, 10.0)], [Event("b", 0.0, 10.0)], eligible_duration_ms=1000.0)
    assert result["true_positives"] == 0
    empty = event_metrics([], [], eligible_duration_ms=1000.0)
    assert empty["precision"] is None and empty["recall"] is None and empty["f1"] is None


def test_invalid_intervals_and_exposure_rejected():
    with pytest.raises(ValueError):
        Event("r", 1.0, 1.0)
    with pytest.raises(ValueError):
        event_metrics([], [], eligible_duration_ms=0.0)


def test_label_validation_and_output_boundary():
    label = Label(
        participant_id="p",
        session_id="s",
        recording_id="r",
        start_backend_ms=0.0,
        end_backend_ms=1000.0,
        label="unknown",
        source="self_report",
    )
    assert label.protocol_version == "0.1.0"
    with pytest.raises(ValueError, match="data/"):
        append_label(Path("evaluation/accidental-labels.jsonl"), label)
    with pytest.raises(ValidationError):
        Label(
            participant_id="p",
            session_id="s",
            recording_id="r",
            start_backend_ms=1000.0,
            end_backend_ms=1000.0,
            label="review",
            source="observer",
        )
