import json
import math
from pathlib import Path

import pytest
from pydantic import ValidationError

from evaluation.eegmat import canonical_hash
from evaluation.splits import Recording, validate_splits
from inference.eeg_workload import WorkloadBundle, load_workload_bundle


def test_portable_model_central_point_and_extreme_logits():
    model = load_workload_bundle()
    prediction = model.predict_features(model.mean)
    assert prediction.score == pytest.approx(1 / (1 + math.exp(-model.intercept)))
    assert prediction.live_automatic is False
    values = model.model_dump(by_alias=False)
    values.update(coefficients=[0.0] * 9, intercept=1000.0)
    assert WorkloadBundle.model_validate(values).predict_features([0.0] * 9).score == 1.0
    values["intercept"] = -1000.0
    assert WorkloadBundle.model_validate(values).predict_features([0.0] * 9).score == 0.0


@pytest.mark.parametrize("features,usable", [([], True), ([math.nan] * 9, True), ([0.0] * 9, False)])
def test_missing_or_unusable_features_abstain(features, usable):
    prediction = load_workload_bundle().predict_features(features, usable=usable)
    assert prediction.state == "unknown" and prediction.score is None


@pytest.mark.parametrize(
    "field,value",
    [
        ("scale", [0.0] * 9),
        ("coefficients", [math.inf] * 9),
        ("channels", ["Cz", "Fz", "Pz"]),
        ("evaluated_modes", ["eeg_only"]),
        ("live_automatic", True),
    ],
)
def test_unsafe_or_incompatible_bundles_rejected(field, value):
    data = load_workload_bundle().model_dump(by_alias=False)
    data[field] = value
    with pytest.raises(ValidationError):
        WorkloadBundle.model_validate(data)


def test_committed_model_report_and_split_integrity():
    root = Path(__file__).resolve().parents[2]
    bundle = json.loads((root / "inference/bundles/eegmat-workload-0.1.0.json").read_text())
    report = json.loads((root / "evaluation/fixtures/eegmat-report.json").read_text())
    assert report["bundle_sha256"] == canonical_hash(bundle)
    assert bundle["split_manifest_sha256"] == canonical_hash(report["split_manifest"])
    validate_splits(
        {name: [Recording(**row) for row in rows] for name, rows in report["split_manifest"].items()}
    )
    assert len(report["recording_sha256"]) == 72
    assert report["metrics"]["test"]["participants"] == 7
    assert report["evaluated_live_modes"] == []
    assert report["event_metrics"] is None
