"""Train a public EEG workload proxy with participant-held-out evaluation.

This command never turns the proxy into lecture attention or live review events.
Source recordings/features stay in ignored storage; only model/report summaries
are written to the supplied artifact directory.
"""

import argparse
import hashlib
import importlib.metadata
import json
import platform
from dataclasses import asdict
from pathlib import Path

from inference.annie_bridge import ANNIE_HASHES, ANNIE_REVISION, preprocess_recording
from inference.eeg_workload import CHANNELS, FEATURE_NAMES, WorkloadBundle, spectral_features

from .eegmat_data import CHECKSUMS_SHA256, DEFAULT_DATA, EDF_FILES, SUBJECTS, verify_dataset
from .splits import Recording, participant_splits

SEED = 17
CANDIDATE_C = (0.01, 0.1, 1.0, 10.0)


def canonical_hash(value) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    ).hexdigest()


def read_eegmat(path: Path):
    import mne
    import numpy as np
    from scipy.signal import resample_poly

    picks = [f"EEG {channel}" for channel in CHANNELS]
    raw = mne.io.read_raw_edf(path, include=picks, preload=False, verbose="ERROR")
    if set(raw.ch_names) != set(picks) or raw.info["sfreq"] != 500.0:
        raise ValueError("EEGMAT source channel/rate mismatch")
    # Equal first-60-s exposure per condition prevents duration/class imbalance.
    if raw.n_times < 30_000:
        raise ValueError("recording is shorter than the prespecified 60 seconds")
    values = raw.get_data(picks=picks, start=0, stop=30_000, units="uV").T
    if not np.isfinite(values).all():
        raise ValueError("non-finite EDF input")
    return resample_poly(values, up=1, down=2, axis=0)


def prepare(data_dir: Path, eeg_source: Path):
    # Verify the complete set before opening any data for model selection.
    checksums = verify_dataset(data_dir)
    records = [
        Recording(subject, subject, Path(name).stem)
        for subject in SUBJECTS
        for name in EDF_FILES
        if name.startswith(subject + "_")
    ]
    splits = participant_splits(records, seed=SEED)
    assignments = {r.recording_id: split for split, rows in splits.items() for r in rows}
    manifest = {split: [asdict(row) for row in rows] for split, rows in splits.items()}
    rows, exclusions = [], []
    for i, name in enumerate(EDF_FILES, 1):
        recording_id = Path(name).stem
        samples = read_eegmat(data_dir / name)
        processed, usable = preprocess_recording(samples, source_root=eeg_source, channel_names=CHANNELS)
        for start in range(2500, len(processed) - 999, 1000):
            if not usable[start : start + 1000].all():
                exclusions.append(
                    {
                        "recording_id": recording_id,
                        "start_sample": start,
                        "reason": "Annie preprocessor quality flags",
                    }
                )
                continue
            try:
                features = spectral_features(processed[start : start + 1000], 250.0, CHANNELS)
            except ValueError:
                exclusions.append(
                    {
                        "recording_id": recording_id,
                        "start_sample": start,
                        "reason": "invalid spectral transform",
                    }
                )
                continue
            rows.append(
                {
                    "participant_id": recording_id.split("_")[0],
                    "recording_id": recording_id,
                    "split": assignments[recording_id],
                    "start_sample": start,
                    "label": int(recording_id.endswith("_2")),
                    "features": features.tolist(),
                }
            )
        if i % 12 == 0:
            print(f"Prepared {i}/{len(EDF_FILES)} recordings", flush=True)
    for subject in SUBJECTS:
        if {row["label"] for row in rows if row["participant_id"] == subject} != {0, 1}:
            raise ValueError("every included participant must retain both conditions")
    return rows, manifest, checksums, exclusions


def classification_metrics(labels, scores, participants) -> dict:
    import numpy as np
    from sklearn.metrics import (
        accuracy_score,
        balanced_accuracy_score,
        confusion_matrix,
        f1_score,
        roc_auc_score,
    )

    truth, probabilities = np.asarray(labels), np.asarray(scores)
    predictions = probabilities >= 0.5
    per_subject = {}
    for subject in sorted(set(participants)):
        mask = np.asarray(participants) == subject
        per_subject[subject] = {
            "windows": int(mask.sum()),
            "balanced_accuracy": float(balanced_accuracy_score(truth[mask], predictions[mask])),
            "roc_auc": float(roc_auc_score(truth[mask], probabilities[mask])),
        }
    return {
        "windows": len(labels),
        "rest_windows": int((truth == 0).sum()),
        "arithmetic_windows": int((truth == 1).sum()),
        "participants": len(per_subject),
        "accuracy": float(accuracy_score(truth, predictions)),
        "balanced_accuracy": float(balanced_accuracy_score(truth, predictions)),
        "macro_participant_balanced_accuracy": float(
            np.mean([row["balanced_accuracy"] for row in per_subject.values()])
        ),
        "f1_arithmetic": float(f1_score(truth, predictions, zero_division=0)),
        "roc_auc": float(roc_auc_score(truth, probabilities)),
        "confusion_matrix_rest_arithmetic": confusion_matrix(truth, predictions, labels=[0, 1]).tolist(),
        "per_participant": per_subject,
    }


def fit_and_evaluate(rows, manifest, checksums, exclusions, output: Path) -> dict:
    import numpy as np
    from sklearn.linear_model import LogisticRegression
    from sklearn.preprocessing import StandardScaler

    subsets = {name: [row for row in rows if row["split"] == name] for name in manifest}
    arrays = {
        name: (np.asarray([row["features"] for row in subset]), np.asarray([row["label"] for row in subset]))
        for name, subset in subsets.items()
    }
    x_train, y_train = arrays["train"]
    # Learned preprocessing is fit once on training participants, never validation/test.
    scaler = StandardScaler().fit(x_train)
    x_val, y_val = arrays["validation"]
    selection = []
    best_classifier, best_value = None, -1.0
    for c_value in CANDIDATE_C:
        classifier = LogisticRegression(
            C=c_value, solver="lbfgs", max_iter=2000, class_weight="balanced", random_state=SEED
        )
        classifier.fit(scaler.transform(x_train), y_train)
        metrics = classification_metrics(
            y_val,
            classifier.predict_proba(scaler.transform(x_val))[:, 1],
            [row["participant_id"] for row in subsets["validation"]],
        )
        score = metrics["macro_participant_balanced_accuracy"]
        selection.append({"c": c_value, "validation_macro_participant_balanced_accuracy": score})
        if score > best_value:  # ties keep the smaller C
            best_classifier, best_value = classifier, score
    model = WorkloadBundle(
        channels=list(CHANNELS),
        feature_names=list(FEATURE_NAMES),
        mean=scaler.mean_.tolist(),
        scale=scaler.scale_.tolist(),
        coefficients=best_classifier.coef_[0].tolist(),
        intercept=float(best_classifier.intercept_[0]),
        regularization_c=best_classifier.C,
        seed=SEED,
        source_revision=ANNIE_REVISION,
        source_hashes=ANNIE_HASHES,
        split_manifest_sha256=canonical_hash(manifest),
    )
    # Freeze the portable model BEFORE any test inference. No refit or test-driven tuning.
    output.mkdir(parents=True, exist_ok=True)
    bundle = model.model_dump(mode="json", by_alias=False)
    (output / "eegmat-workload-0.1.0.json").write_text(
        json.dumps(bundle, indent=2, allow_nan=False) + "\n", encoding="utf-8"
    )
    results = {}
    for name in ("train", "validation", "test"):
        x, y = arrays[name]
        scores = np.asarray([model.predict_features(row.tolist()).score for row in x])
        # Verify the exported JSON semantics match the fitted sklearn classifier.
        expected = best_classifier.predict_proba(scaler.transform(x))[:, 1]
        if not np.allclose(scores, expected, atol=1e-12, rtol=0):
            raise ValueError("portable model differs from training pipeline")
        results[name] = classification_metrics(y, scores, [r["participant_id"] for r in subsets[name]])
    subject_values = [r["balanced_accuracy"] for r in results["test"]["per_participant"].values()]
    rng = np.random.default_rng(SEED)
    bootstrap = rng.choice(subject_values, size=(2000, len(subject_values)), replace=True).mean(axis=1)
    report = {
        "report_kind": "public_source_domain_workload_evaluation",
        "dataset": "EEGMAT-1.0.0",
        "dataset_url": "https://physionet.org/content/eegmat/1.0.0/",
        "licence": "ODC-By-1.0",
        "target": "rest=0; mental_arithmetic=1 (not attention or lecture lapse)",
        "model_version": "0.1.0",
        "seed": SEED,
        "bundle_sha256": canonical_hash(bundle),
        "upstream_checksum_manifest_sha256": CHECKSUMS_SHA256,
        "recording_sha256": checksums,
        "split_manifest_sha256": canonical_hash(manifest),
        "split_manifest": manifest,
        "preprocessing": {
            "annie_revision": ANNIE_REVISION,
            "annie_file_sha256": ANNIE_HASHES,
            "channels": list(CHANNELS),
            "source_hz": 500.0,
            "model_hz": 250.0,
            "offline_resampler": "scipy.signal.resample_poly(up=1,down=2)",
            "causal_bandpass_hz": [1.0, 40.0],
            "remove_dc_offset": True,
            "notch": None,
            "max_amplitude_uv": 500.0,
            "recording_prefix_seconds": 60.0,
            "discard_startup_seconds": 10.0,
            "window_seconds": 4.0,
            "stride_seconds": 4.0,
            "welch_segment_seconds": 2.0,
            "welch_overlap_seconds": 1.0,
            "bands_hz_half_open": {
                name: [low, high]
                for name, low, high in (("theta", 4.0, 8.0), ("alpha", 8.0, 13.0), ("beta", 13.0, 30.0))
            },
        },
        "selection": selection,
        "selected_c": best_classifier.C,
        "threshold": 0.5,
        "metrics": results,
        "constant_baseline_balanced_accuracy": 0.5,
        "test_macro_participant_balanced_accuracy_bootstrap_95pct": np.quantile(
            bootstrap, [0.025, 0.975]
        ).tolist(),
        "exclusions": exclusions,
        "evaluated_live_modes": [],
        "event_metrics": None,
        "event_metrics_reason": "source has task labels, not lecture lapse events",
        "gaze_only_and_combined": "not evaluated: no synchronised gaze in EEGMAT",
        "software": {
            "python": platform.python_version(),
            **{name: importlib.metadata.version(name) for name in ("numpy", "scipy", "scikit-learn", "mne")},
        },
    }
    (output / "eegmat-report.json").write_text(
        json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8"
    )
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--eeg-source", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=DEFAULT_DATA.parent / "eegmat-run")
    args = parser.parse_args()
    rows, manifest, checksums, exclusions = prepare(args.data_dir, args.eeg_source)
    report = fit_and_evaluate(rows, manifest, checksums, exclusions, args.output)
    print(
        json.dumps(
            {
                "selected_c": report["selected_c"],
                "test": report["metrics"]["test"],
                "exclusions": len(exclusions),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
