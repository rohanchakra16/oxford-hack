"""Optional scientific tests. Install inference/requirements-public-eeg.txt to run."""

import importlib
import json
import os
import sys
from dataclasses import replace
from pathlib import Path

import pytest

from evaluation.eegmat import fit_and_evaluate
from inference.annie_bridge import load_annie_api, preprocess_recording
from inference.eeg_workload import CHANNELS, load_workload_bundle, predict_window, spectral_features
from inference.workload_cli import score_batch

np = pytest.importorskip("numpy")
pytest.importorskip("scipy")


def waves(seconds=4):
    t = np.arange(seconds * 250) / 250.0
    return np.stack([10 * np.sin(2 * np.pi * frequency * t) for frequency in (6, 10, 20)], axis=1)


def test_spectral_bands_channel_order_and_gain_invariance():
    data = waves()
    features = spectral_features(data, 250.0, CHANNELS)
    assert np.argmax(features.reshape(3, 3), axis=1).tolist() == [0, 1, 2]
    np.testing.assert_allclose(features, spectral_features(data[:, [2, 0, 1]], 250.0, ["Pz", "Fz", "Cz"]))
    np.testing.assert_allclose(features, spectral_features(data * 10, 250.0, CHANNELS), atol=1e-10)


@pytest.mark.parametrize(
    "values,rate,names",
    [
        (np.zeros((1000, 3)), 250.0, CHANNELS),
        (waves()[:900], 250.0, CHANNELS),
        (waves(), 500.0, CHANNELS),
        (waves(), 250.0, ["EEG1", "EEG2", "EEG3"]),
    ],
)
def test_bad_windows_return_unknown(values, rate, names):
    prediction = predict_window(load_workload_bundle(), values, rate, names)
    assert prediction.state == "unknown" and prediction.score is None


def test_training_scaler_cannot_see_validation_or_test(tmp_path):
    pytest.importorskip("sklearn")
    rows, manifest = [], {}
    for split, offset in (("train", 0.0), ("validation", 10.0), ("test", 1000.0)):
        manifest[split] = [{"participant_id": split, "session_id": split, "recording_id": split}]
        for label, direction in ((0, -1), (1, 1)):
            rows.append(
                {
                    "participant_id": split,
                    "recording_id": split,
                    "split": split,
                    "label": label,
                    "features": [offset + direction] * 9,
                }
            )
    fit_and_evaluate(rows, manifest, {}, [], tmp_path)
    model = json.loads((tmp_path / "eegmat-workload-0.1.0.json").read_text())
    assert model["mean"] == [0.0] * 9
    assert model["scale"] == [1.0] * 9


@pytest.fixture
def annie_source():
    default = Path(__file__).resolve().parents[2] / "inference/.local/annie-f20ee35"
    source = Path(os.environ.get("EEG_SOURCE", str(default)))
    if not (source / "eeg/acquisition/base_device.py").is_file():
        pytest.skip("Annie's pinned read-only EEG source is not present")
    # The bridge deliberately loads the pinned eeg package in this process.
    # Isolate it from current-owner realtime tests, in either execution order.
    saved = {name: module for name, module in sys.modules.items() if name == "eeg" or name.startswith("eeg.")}
    for name in saved:
        sys.modules.pop(name, None)
    importlib.invalidate_caches()
    try:
        yield source
    finally:
        for name in list(sys.modules):
            if name == "eeg" or name.startswith("eeg."):
                sys.modules.pop(name, None)
        sys.modules.update(saved)
        importlib.invalidate_caches()


def test_annie_export_load_and_scoring_compatibility(annie_source, tmp_path):
    batch_type, _ = load_annie_api(annie_source)
    samples = waves(18)
    indices = np.arange(len(samples), dtype=np.int64)
    batch = batch_type(
        samples=samples,
        timestamps=indices / 250.0,
        sample_indices=indices,
        channel_names=CHANNELS,
        sampling_frequency_hz=250.0,
        signal_units="uV",
    )
    dataset = importlib.import_module("eeg.dataset")
    database = dataset.RecordingDatabase(tmp_path / "recordings.sqlite", tmp_path / "arrays")
    try:
        metadata = database.create_recording("scripted compatibility only", batch)
        path = dataset.DatasetExporter(database).export_recording(
            metadata.recording_id, tmp_path / "export.npz"
        )
        loaded = dataset.DatasetLoader().load(path).sample_batch
        results = score_batch(load_workload_bundle(), loaded, eeg_source=annie_source)
    finally:
        database.close()
    assert len(results) == 2
    assert all(r["prediction"]["state"] == "ok" for r in results)
    assert results[0]["start_device_s"] == 10.0
    bad_units = replace(batch, signal_units="V")
    assert (
        score_batch(load_workload_bundle(), bad_units, eeg_source=annie_source)[0]["prediction"]["score"]
        is None
    )
    broken_indices = indices.copy()
    broken_indices[2000:] += 1
    gap = replace(batch, sample_indices=broken_indices)
    assert (
        score_batch(load_workload_bundle(), gap, eeg_source=annie_source)[0]["prediction"]["state"]
        == "unknown"
    )


def test_annie_quality_mask_and_model_abstention(annie_source):
    samples = waves(18)
    samples[3000, 0] = np.nan
    _, usable = preprocess_recording(samples, source_root=annie_source, channel_names=CHANNELS)
    assert not usable[3000:3250].any()
    prediction = predict_window(
        load_workload_bundle(), waves(), 250.0, CHANNELS, usable=bool(usable[2500:3500].all())
    )
    assert prediction.state == "unknown" and prediction.score is None
