"""Bounded live evaluation of Annie's frames; no EEG filters or biomarkers.

Time values are in the evaluator's monotonic clock, never Unix wall time.
Predictions are experimental and never publish platform review events.
"""

import math
from collections import Counter, deque
from dataclasses import dataclass
from numbers import Real


def finite(value):
    return isinstance(value, Real) and not isinstance(value, bool) and math.isfinite(value)


@dataclass(frozen=True)
class AttentionLabel:
    """Independent session-relative annotation, with an exclusive end."""

    start_s: float
    end_s: float
    label: str

    def __post_init__(self):
        if (
            not finite(self.start_s)
            or not finite(self.end_s)
            or not 0 <= self.start_s < self.end_s
            or self.label not in {"attentive", "inattentive", "unknown"}
        ):
            raise ValueError("invalid independent attention label")


def window_label(labels, start_s, end_s, uncertainty_s):
    if (
        not finite(start_s)
        or not finite(end_s)
        or end_s <= start_s
        or not finite(uncertainty_s)
        or not 0 <= uncertainty_s <= 0.05
    ):
        return None
    return next(
        (
            item.label
            for item in labels
            if item.start_s - 1e-9 <= start_s - uncertainty_s and end_s + uncertainty_s <= item.end_s + 1e-9
        ),
        None,
    )


class LiveEvaluation:
    """Evaluate complete windows, heartbeat on stalls, keep bounded timing data.

    ``lecture_attention`` explicitly declares the supplied model's target; it
    does not certify that model. A stub or workload model never becomes attention.
    Labels are withheld from the classifier and used only for evaluation.
    """

    def __init__(
        self,
        *,
        session_id,
        started_s,
        model_id="unavailable",
        model_target="unavailable",
        threshold=50.0,
        window_s=2.0,
        update_s=0.5,
        stale_s=1.0,
        labels=(),
    ):
        if (
            not session_id
            or not finite(started_s)
            or not finite(threshold)
            or not 0 <= threshold <= 100
            or any(not finite(x) or x <= 0 for x in (window_s, update_s, stale_s))
        ):
            raise ValueError("invalid live evaluation configuration")
        self.session_id, self.started_s = session_id, started_s
        self.model_id, self.model_target, self.threshold = model_id, model_target, threshold
        self.window_s, self.update_s, self.stale_s = window_s, update_s, stale_s
        self.labels = sorted(labels, key=lambda x: x.start_s)
        if any(a.end_s > b.start_s for a, b in zip(self.labels, self.labels[1:], strict=False)):
            raise ValueError("independent label intervals must not overlap")
        self.counts, self.confusion = Counter(), Counter()
        self.ages, self.intervals = deque(maxlen=4096), deque(maxlen=4096)
        self.last_received = self.last_index = self.last_end = None
        self.last_now = started_s
        self._stalled = False

    def _clock(self, now):
        if not finite(now) or now < self.last_now:
            raise ValueError("evaluation requires a finite monotonic clock")
        self.last_now = now

    def observe(self, frame, *, now_s, mapped_end_s=None, clock_uncertainty_s=None):
        self._clock(now_s)
        reasons = []
        index = frame.get("frame_index")
        start, end = frame.get("window_start_timestamp"), frame.get("window_end_timestamp")
        metadata = frame.get("preprocessed_metadata", {})
        rate = metadata.get("sampling_frequency_hz")
        bounds = frame.get("sample_indices", ())
        geometry_ok = (
            isinstance(index, int)
            and not isinstance(index, bool)
            and index >= 0
            and finite(start)
            and finite(end)
            and end > start
            and finite(rate)
            and rate > 0
            and len(bounds) == 2
            and all(isinstance(x, int) and not isinstance(x, bool) for x in bounds)
            and bounds[1] - bounds[0] + 1 == math.ceil(self.window_s * rate)
            and abs(end - start + 1 / rate - self.window_s) <= 1.5 / rate
        )
        if not geometry_ok:
            reasons.append("invalid_window")
        ordered = (
            geometry_ok
            and (self.last_index is None or index > self.last_index)
            and (self.last_end is None or end > self.last_end)
        )
        if geometry_ok and not ordered:
            reasons.append("duplicate_or_out_of_order")
        if ordered:
            if self.last_received is not None:
                self.intervals.append((now_s - self.last_received) * 1000)
                if index != self.last_index + 1:
                    reasons.append("dropped_frames")
            self.last_index, self.last_end, self.last_received = index, end, now_s
            self._stalled = False

        age = None
        if (
            not finite(mapped_end_s)
            or not finite(clock_uncertainty_s)
            or not 0 <= clock_uncertainty_s <= 0.05
        ):
            reasons.append("clock_unmapped_or_uncertain")
        else:
            age = now_s - mapped_end_s
            if age < -clock_uncertainty_s:
                reasons.append("future_window")
            elif age + clock_uncertainty_s > self.stale_s:
                reasons.append("stale_window")
            if age >= 0:
                self.ages.append(age * 1000)

        quality = frame.get("evaluation_quality", {})
        if quality.get("whole_window") is not True or quality.get("usable") is not True:
            reasons.append("whole_window_quality_unusable_or_missing")
        features = frame.get("features", {})
        if not features or any(
            item.get("valid") is not True or not finite(item.get("value")) for item in features.values()
        ):
            reasons.append("features_unavailable")
        prediction = frame.get("prediction", {})
        score = prediction.get("attention_score")
        if (
            self.model_target != "lecture_attention"
            or prediction.get("model_type") in {None, "stub"}
            or prediction.get("valid") is not True
            or frame.get("prediction_valid") is not True
            or not finite(score)
            or not 0 <= score <= 100
        ):
            reasons.append("attention_model_unavailable")
        state = "unknown" if reasons else "attentive" if score >= self.threshold else "inattentive"
        self.counts["frames"] += 1
        self.counts[state] += 1
        self.counts.update(f"reason:{reason}" for reason in reasons)
        truth = label_start = label_end = None
        if geometry_ok and finite(mapped_end_s):
            label_end = mapped_end_s - self.started_s + 1 / rate
            label_start = label_end - self.window_s
            truth = window_label(self.labels, label_start, label_end, clock_uncertainty_s)
        if truth in {"attentive", "inattentive"}:
            self.confusion[truth, state] += 1
        return {
            "type": "evaluation_frame",
            "session_id": self.session_id,
            "experimental": True,
            "model_id": self.model_id,
            "model_target": self.model_target,
            "elapsed_s": now_s - self.started_s,
            "frame_index": index,
            "state": state,
            "attention_score": float(score) if not reasons else None,
            "reasons": reasons,
            "window_end_device_s": end if finite(end) else None,
            "window_start_elapsed_s": label_start,
            "window_end_elapsed_s": label_end,
            "clock_uncertainty_s": clock_uncertainty_s if finite(clock_uncertainty_s) else None,
            "evidence_age_ms": None if age is None else age * 1000,
            "independent_label": truth,
            "features": {
                name: {
                    "value": float(item["value"]) if finite(item.get("value")) else None,
                    "valid": item.get("valid") is True and finite(item.get("value")),
                }
                for name, item in features.items()
            },
        }

    def poll(self, now_s):
        """Emit one unknown transition per stall, including no first frame."""
        self._clock(now_s)
        reference = self.last_received if self.last_received is not None else self.started_s + self.window_s
        if now_s - reference <= self.stale_s or self._stalled:
            return None
        self._stalled = True
        self.counts["stall_transitions"] += 1
        return {
            "type": "evaluation_status",
            "session_id": self.session_id,
            "experimental": True,
            "elapsed_s": now_s - self.started_s,
            "state": "unknown",
            "reasons": ["stream_stalled"],
            "attention_score": None,
        }

    def report(self):
        def quantile(values, q):
            return sorted(values)[math.ceil(len(values) * q) - 1] if values else None

        tp = self.confusion["inattentive", "inattentive"]
        fp = self.confusion["attentive", "inattentive"]
        fn = self.confusion["inattentive", "attentive"]
        scored = sum(
            self.confusion[t, p] for t in ("attentive", "inattentive") for p in ("attentive", "inattentive")
        )
        labelled = sum(self.confusion.values())
        return {
            "session_id": self.session_id,
            "experimental": True,
            "model_id": self.model_id,
            "model_target": self.model_target,
            "live_automatic": False,
            "window_s": self.window_s,
            "update_s": self.update_s,
            "threshold": self.threshold,
            "counts": dict(self.counts),
            "timing_sample_limit": 4096,
            "evidence_age_p95_ms": quantile(self.ages, 0.95),
            "update_interval_p95_ms": quantile(self.intervals, 0.95),
            "labelled_frames": labelled,
            "labelled_scored_frames": scored,
            "labelled_coverage": scored / labelled if labelled else None,
            "frame_accuracy": ((self.confusion["attentive", "attentive"] + tp) / scored if scored else None),
            "inattention_precision": tp / (tp + fp) if tp + fp else None,
            "inattention_recall_on_scored": tp / (tp + fn) if tp + fn else None,
            "confusion": {f"{truth}->{pred}": n for (truth, pred), n in self.confusion.items()},
            "limitations": [
                "Overlapping frames are correlated, not independent samples.",
                "Timing quantiles describe the most recent 4096 observations.",
                "Accuracy requires independent labels and a supplied attention model.",
                "This runner does not publish review events or measure learning.",
            ],
        }
