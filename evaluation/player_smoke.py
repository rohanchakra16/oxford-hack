"""Write small reproducible player-evaluation summaries, without EEG waveforms."""

import argparse
import json
from pathlib import Path

from evaluation.lecture_replay import (
    mode_config,
    run_replay,
    synthetic_ticks,
    workload_ticks,
)
from evaluation.player_api import CONSERVATIVE, PLAYER_SCENARIO
from inference.lecture_types import LectureConfig


def summary(ticks, config):
    report, _ = run_replay(ticks, config)
    return {
        "metrics": report["metrics"],
        "review_ranges": [s["mediaRange"] for s in report["segments"]],
        "config": report["config"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workload-json", type=Path)
    parser.add_argument(
        "--recording-name",
        help="Public recording name for reproducible EEGMAT provenance",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).parent / "fixtures/player-smoke-report.json",
    )
    args = parser.parse_args()
    config = LectureConfig.model_validate_json(CONSERVATIVE.read_text())
    spec = json.loads(PLAYER_SCENARIO.read_text())
    nuisance = dict(
        spec,
        duration_s=120,
        score_blocks=[
            {"start_s": 10, "end_s": 18, "score": 0.1},
            {"start_s": 35, "end_s": 48, "score": 0.35},
            {"start_s": 65, "end_s": 95, "score": 0.05},
        ],
    )
    result = {
        "prototype": True,
        "player_smoke": summary(synthetic_ticks(spec), config),
        "scripted_comparison": {
            "original": summary(synthetic_ticks(nuisance), mode_config("normal")),
            "conservative": summary(synthetic_ticks(nuisance), config),
        },
        "limitation": "Scripted trigger counts only; EEGMAT has no lecture-attention ground truth. Accuracy and false-positive rate are unavailable.",
    }
    if args.workload_json:
        payload = json.loads(args.workload_json.read_text(encoding="utf-8-sig"))
        ticks = workload_ticks(payload)
        result["eegmat_workload_demo"] = {
            "windows": len(payload["windows"]),
            "hypothetical_timeline": True,
            "original": summary(ticks, mode_config("normal")),
            "conservative": summary(ticks, config),
        }
        if args.recording_name:
            manifest = json.loads(
                (Path(__file__).parent / "fixtures/eegmat-report.json").read_text()
            )
            if args.recording_name not in manifest["recording_sha256"]:
                parser.error("recording name is not in the verified EEGMAT manifest")
            result["eegmat_workload_demo"]["provenance"] = {
                "recording_name": args.recording_name,
                "recording_sha256": manifest["recording_sha256"][args.recording_name],
                "bundle_sha256": manifest["bundle_sha256"],
            }
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(args.output)


if __name__ == "__main__":
    main()
