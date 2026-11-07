"""One-to-one event matching within recordings, with explicit exposure."""

from dataclasses import dataclass
from math import isfinite


@dataclass(frozen=True)
class Event:
    recording_id: str
    start_ms: float
    end_ms: float

    def __post_init__(self):
        if (
            not self.recording_id
            or not isfinite(self.start_ms)
            or not isfinite(self.end_ms)
            or self.start_ms < 0
            or self.end_ms <= self.start_ms
        ):
            raise ValueError("events require a recording and finite positive-duration interval")


def interval_iou(a: Event, b: Event) -> float:
    if a.recording_id != b.recording_id:
        return 0.0
    overlap = max(0.0, min(a.end_ms, b.end_ms) - max(a.start_ms, b.start_ms))
    return overlap / (max(a.end_ms, b.end_ms) - min(a.start_ms, b.start_ms))


def event_metrics(
    truth: list[Event], predictions: list[Event], *, eligible_duration_ms: float, min_iou: float = 0.3
) -> dict:
    """Maximum-cardinality bipartite matching (not order-dependent greedy matching).

    Caller supplies only independently labelled, eligible intervals. Exposure must
    include eligible negative time, excluding unknown and interrupted time.
    """
    if not isfinite(min_iou) or not 0 < min_iou <= 1:
        raise ValueError("min_iou must be in (0, 1]")
    if not isfinite(eligible_duration_ms) or eligible_duration_ms <= 0:
        raise ValueError("eligible exposure must be finite and positive")
    adjacency = [[j for j, t in enumerate(truth) if interval_iou(p, t) >= min_iou] for p in predictions]
    matched_truth: dict[int, int] = {}

    def augment(i: int, visited: set[int]) -> bool:
        for j in adjacency[i]:
            if j in visited:
                continue
            visited.add(j)
            if j not in matched_truth or augment(matched_truth[j], visited):
                matched_truth[j] = i
                return True
        return False

    tp = sum(augment(i, set()) for i in range(len(predictions)))
    fp, fn = len(predictions) - tp, len(truth) - tp
    precision = tp / (tp + fp) if tp + fp else None
    recall = tp / (tp + fn) if tp + fn else None
    return {
        "true_positives": tp,
        "false_positives": fp,
        "false_negatives": fn,
        "precision": precision,
        "recall": recall,
        "f1": 2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else None,
        "false_positives_per_eligible_hour": fp * 3_600_000 / eligible_duration_ms,
        "eligible_duration_ms": eligible_duration_ms,
        "min_iou": min_iou,
    }
