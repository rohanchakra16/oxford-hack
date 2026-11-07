"""Score an existing derived live journal against later independent labels.

This never reruns or tunes the classifier and does not require EEG hardware.
"""

import argparse
import json
from pathlib import Path

from .realtime import AttentionLabel, LiveEvaluation, window_label


def score_journal(rows, *, session_id, labels):
    evaluator = LiveEvaluation(session_id=session_id, started_s=0, labels=labels)
    for row in rows:
        if row.get("session_id") != session_id:
            raise ValueError("journal session_id does not match labels")
        if row.get("type") != "evaluation_frame":
            continue
        state = row.get("state")
        if state not in {"attentive", "inattentive", "unknown"}:
            raise ValueError("invalid journal classification")
        if state != "unknown" and row.get("model_target") != "lecture_attention":
            raise ValueError("non-attention journal cannot contain attention classifications")
        truth = window_label(
            evaluator.labels,
            row.get("window_start_elapsed_s"),
            row.get("window_end_elapsed_s"),
            row.get("clock_uncertainty_s"),
        )
        evaluator.counts["frames"] += 1
        evaluator.counts[state] += 1
        if truth in {"attentive", "inattentive"}:
            evaluator.confusion[truth, state] += 1
    result = evaluator.report()
    result.update(
        type="independent_label_report",
        model_target="journal_declared_models",
        model_id="unchanged_journal_predictions",
        threshold=None,
        window_s=None,
        update_s=None,
    )
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--journal", type=Path, required=True)
    parser.add_argument("--labels", type=Path, required=True)
    args = parser.parse_args()
    try:
        payload = json.loads(args.labels.read_text(encoding="utf-8"))
        labels = [AttentionLabel(**item) for item in payload["intervals"]]
        with args.journal.open(encoding="utf-8") as source:
            report = score_journal(
                (json.loads(line) for line in source if line.strip()),
                session_id=payload["session_id"],
                labels=labels,
            )
    except (ValueError, OSError, KeyError) as exc:
        parser.error(str(exc))
    print(json.dumps(report, allow_nan=False))


if __name__ == "__main__":
    main()
