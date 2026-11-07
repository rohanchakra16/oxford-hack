"""Synthetic pipeline smoke report. This is NOT held-out performance evaluation."""

import hashlib
import json

from inference.demo import run_demo
from inference.model import DEFAULT_BUNDLE

from .metrics import Event, event_metrics


def report() -> dict:
    modes = {}
    for mode in ("eeg_only", "gaze_only", "both"):
        demo = run_demo(mode)
        predictions = [
            Event("synthetic-recording", c["evidence"]["startBackendMs"], c["evidence"]["endBackendMs"])
            for c in demo["candidates"]
        ]
        modes[mode] = {
            "scripted_event_metrics": event_metrics(
                [Event("synthetic-recording", 0.0, 6000.0)], predictions, eligible_duration_ms=7000.0
            ),
            "unknown_observed": any(s["state"] == "unknown" for s in demo["statuses"]),
            "interrupted_observed": demo["statuses"][-1]["state"] == "interrupted",
        }
    return {
        "report_kind": "synthetic_smoke_only",
        "model_version": "0.1.0",
        "config_version": "synthetic-0.1.0",
        "seed": 17,
        "bundle_sha256": hashlib.sha256(
            json.dumps(
                json.loads(DEFAULT_BUNDLE.read_text(encoding="utf-8")), sort_keys=True, separators=(",", ":")
            ).encode("utf-8")
        ).hexdigest(),
        "evaluated_live_modes": [],
        "modes": modes,
        "limitations": "Scripted fixtures only; no participant data, trained model or held-out accuracy.",
    }


if __name__ == "__main__":
    print(json.dumps(report(), indent=2, allow_nan=False))
