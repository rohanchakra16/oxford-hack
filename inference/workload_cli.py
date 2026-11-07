"""Score EEG recordings with the public workload proxy; never create bookmarks."""

import argparse
import importlib
import json
from pathlib import Path

from .annie_bridge import ANNIE_HASHES, ANNIE_REVISION, load_annie_api, preprocess_recording
from .eeg_workload import CHANNELS, WorkloadPrediction, load_workload_bundle, predict_window


def score_batch(model, batch, *, eeg_source: Path) -> list[dict]:
    """Consume Annie's SampleBatch, retaining device-clock seconds in the output.

    This is an offline recording scorer. It resets the source preprocessor for
    each recording and discards its first 10 s. The platform owns clock mapping.
    """
    import numpy as np

    def unknown(reason):
        return [{"prediction": WorkloadPrediction(state="unknown", reason=reason).model_dump(by_alias=False)}]

    if model.source_revision != ANNIE_REVISION or model.source_hashes != ANNIE_HASHES:
        return unknown("model preprocessing source differs from the verified bridge")
    if batch.signal_units != "uV" or batch.sampling_frequency_hz != 250.0:
        return unknown("requires confirmed uV signals at 250 Hz")
    names = list(batch.channel_names)
    if len(set(names)) != len(names) or not all(channel in names for channel in CHANNELS):
        return unknown("requires confirmed named Fz/Cz/Pz electrodes")
    times = np.asarray(batch.timestamps)
    indices = np.asarray(batch.sample_indices)
    if (
        len(times) != len(batch.samples)
        or len(times) < 3500
        or not np.isfinite(times).all()
        or np.any(np.diff(indices) != 1)
        or np.any(np.diff(times) <= 0)
        or np.any(np.abs(np.diff(times) - 1 / 250.0) > 0.002)
    ):
        return unknown("incomplete, discontinuous or invalid recording timestamps")
    samples = np.asarray(batch.samples)[:, [names.index(channel) for channel in CHANNELS]]
    processed, usable = preprocess_recording(samples, source_root=eeg_source, channel_names=CHANNELS)
    result = []
    for start in range(
        model.settling_samples, len(processed) - model.window_samples + 1, model.window_samples
    ):
        stop = start + model.window_samples
        prediction = predict_window(
            model, processed[start:stop], 250.0, CHANNELS, usable=bool(usable[start:stop].all())
        )
        result.append(
            {
                "start_device_s": float(times[start]),
                "end_device_s": float(times[stop - 1] + 1 / 250.0),
                "prediction": prediction.model_dump(by_alias=False),
            }
        )
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--eeg-source", type=Path, required=True)
    parser.add_argument("--model", type=Path)
    inputs = parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument("--recording", type=Path, help="Annie DatasetExporter NPZ/CSV recording")
    inputs.add_argument("--eegmat-file", type=Path, help="checksum-verified public EDF demo")
    args = parser.parse_args()
    model = load_workload_bundle(args.model) if args.model else load_workload_bundle()
    batch_type, _ = load_annie_api(args.eeg_source)
    if args.recording:
        loader = importlib.import_module("eeg.dataset.dataset_loader").DatasetLoader()
        batch = loader.load(args.recording).sample_batch
    else:
        import numpy as np

        from evaluation.eegmat import read_eegmat
        from evaluation.eegmat_data import EDF_FILES, verify_dataset

        if args.eegmat_file.name not in EDF_FILES:
            parser.error("not a recognised EEGMAT filename")
        verify_dataset(args.eegmat_file.parent)
        samples = read_eegmat(args.eegmat_file)
        indices = np.arange(len(samples), dtype=np.int64)
        batch = batch_type(
            samples=samples,
            timestamps=indices / 250.0,
            sample_indices=indices,
            channel_names=CHANNELS,
            sampling_frequency_hz=250.0,
            signal_units="uV",
        )
    print(
        json.dumps(
            {
                "target": model.target,
                "live_automatic": False,
                "windows": score_batch(model, batch, eeg_source=args.eeg_source),
            },
            indent=2,
            allow_nan=False,
        )
    )


if __name__ == "__main__":
    main()
