"""Live evaluation CLI using the EEG owner's producer/consumer pipeline.

Factories return an unconnected LiveSession. Live clock conversion and EEG-only
channel selection must be confirmed by the source owner; neither is guessed.
"""

import argparse
import importlib
import json
import queue
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Any
from uuid import uuid4

from .realtime import AttentionLabel, LiveEvaluation, finite


class WindowQuality:
    """Decorate Annie's preprocessor; retain quality spans, never raw EEG.

    This aggregates her basic diagnostics; it is not complete artifact removal.
    Discontinuity resets causal filter state and requires fresh warmup evidence.
    """

    def __init__(self, preprocessor, *, warmup_s=10.0):
        if not finite(warmup_s) or warmup_s < 0:
            raise ValueError("warmup must be finite and nonnegative")
        self.preprocessor, self.warmup_s = preprocessor, warmup_s
        self._lock = Lock()
        self.reset()

    def reset(self):
        self.preprocessor.reset()
        with self._lock:
            self.spans = deque(maxlen=4096)
            self.last_index = self.last_time = self.origin_index = self.rate = None

    def process(self, batch):
        import numpy as np

        indices, stamps = batch.sample_indices, batch.timestamps
        first, last = int(indices[0]), int(indices[-1])
        rate = batch.sampling_frequency_hz
        with self._lock:
            continuous = (
                np.isfinite(stamps).all()
                and np.all(np.diff(indices) == 1)
                and np.all(np.abs(np.diff(stamps) - 1 / rate) <= 0.5 / rate)
                and (
                    self.last_index is None
                    or (
                        first == self.last_index + 1
                        and self.rate == rate
                        and abs(float(stamps[0]) - self.last_time - 1 / rate) <= 0.5 / rate
                    )
                )
            )
            if not continuous:
                self.preprocessor.reset()
                self.spans.clear()
                self.origin_index = first
            if self.origin_index is None:
                self.origin_index = first
            result = self.preprocessor.process(batch)
            q = result.quality
            usable = (
                continuous
                and np.isfinite(batch.samples).all()
                and np.isfinite(stamps).all()
                and np.all(np.diff(indices) == 1)
                and np.all(np.abs(np.diff(stamps) - 1 / rate) <= 0.5 / rate)
                and np.all(np.ptp(batch.samples, axis=0) > 1e-12)
                and batch.signal_units == "uV"
                and not any(
                    q.get(name, True)
                    for name in (
                        "missing_sample_count",
                        "non_finite_sample_count",
                        "flatline_channels",
                        "excessive_amplitude_channels",
                    )
                )
            )
            self.spans.append((first, last, bool(usable)))
            self.last_index, self.last_time, self.rate = last, float(stamps[-1]), rate
        return result

    def annotate(self, frame):
        start, end = frame["sample_indices"]
        with self._lock:
            cursor, usable = start, True
            for first, last, good in self.spans:
                if last < start or first > end:
                    continue
                if first > cursor:
                    usable = False
                usable = usable and good
                cursor = max(cursor, last + 1)
            complete = cursor > end
            warmed = (
                self.origin_index is not None
                and self.rate is not None
                and start - self.origin_index >= self.warmup_s * self.rate
            )
        return {
            **frame,
            "evaluation_quality": {
                "whole_window": complete,
                "usable": bool(complete and usable and warmed),
                "warmup_complete": warmed,
                "scope": "basic_checks_only",
            },
        }


@dataclass
class LiveSession:
    device: Any
    preprocessor: Any
    feature_extractor: Any
    classifier: Any
    source_kind: str = "live"
    model_id: str = "unavailable"
    model_target: str = "unavailable"
    eeg_only_confirmed: bool = False
    # Return (host monotonic seconds, uncertainty seconds), or None.
    map_time: Callable[[float], tuple[float, float] | None] | None = None


def mock_session():
    from eeg.acquisition.mock_device import MockEEGDevice
    from eeg.processing.signal_preprocessor import EEGPreprocessor
    from eeg.realtime.attention_classifier import StubAttentionClassifier
    from eeg.realtime.feature_extractor import EEGFeatureExtractor
    from eeg.realtime.feature_registry import FeatureRegistry
    from eeg.realtime.stub_features import STUB_FEATURES

    registry = FeatureRegistry()
    registry.register_many(STUB_FEATURES.items())
    return LiveSession(
        MockEEGDevice(seed=31),
        EEGPreprocessor(),
        EEGFeatureExtractor(registry),
        StubAttentionClassifier(),
        source_kind="synthetic",
        model_id="annie-stub",
        eeg_only_confirmed=True,
    )


def run_session(
    session,
    *,
    duration_s=10.0,
    window_s=2.0,
    update_s=0.5,
    stale_s=1.0,
    warmup_s=10.0,
    threshold=50.0,
    session_id=None,
    labels=(),
    emit=None,
):
    """Emit live JSON-safe frames/status and return a summary; always clean up."""
    from eeg.realtime.streaming_controller import StreamingController

    if not finite(duration_s) or duration_s <= 0:
        raise ValueError("duration must be finite and positive")
    if session.source_kind not in {"synthetic", "live", "replay"} or not session.eeg_only_confirmed:
        raise ValueError("source factory must confirm EEG-only channels and source kind")
    tracker = WindowQuality(session.preprocessor, warmup_s=warmup_s)
    started = time.monotonic()
    evaluator = LiveEvaluation(
        session_id=session_id or uuid4().hex,
        started_s=started,
        model_id=session.model_id,
        model_target=session.model_target,
        threshold=threshold,
        window_s=window_s,
        update_s=update_s,
        stale_s=stale_s,
        labels=labels,
    )
    controller = StreamingController(
        session.device,
        tracker,
        session.feature_extractor,
        session.classifier,
        window_duration_seconds=window_s,
        update_interval_seconds=update_s,
        window_overlap=max(0, 1 - update_s / window_s),
        output_capacity=8,
    )
    emit = emit or (lambda row: print(json.dumps(row, allow_nan=False), flush=True))
    error = None
    try:
        session.device.connect()
        controller.start()
        # The owner's mock timestamps start at sample index zero. This mapping
        # is simulation-only; never infer a live device offset from arrival.
        if session.source_kind == "synthetic" and session.map_time is None:
            origin = time.monotonic()

            def mapper(stamp):
                return origin + stamp, 0.01
        else:
            mapper = session.map_time
        while time.monotonic() - started < duration_s:
            if controller.error is not None:
                raise RuntimeError(str(controller.error))
            remaining = duration_s - (time.monotonic() - started)
            try:
                frame = controller.get_frame(timeout=max(0.001, min(0.1, remaining)))
            except queue.Empty:
                status = evaluator.poll(time.monotonic())
                if status:
                    emit(status)
                continue
            frame = tracker.annotate(frame)
            mapped = mapper(frame["window_end_timestamp"]) if mapper else None
            emit(
                evaluator.observe(
                    frame,
                    now_s=time.monotonic(),
                    mapped_end_s=mapped[0] if mapped else None,
                    clock_uncertainty_s=mapped[1] if mapped else None,
                )
            )
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
    finally:
        for cleanup in (controller.stop, session.device.disconnect):
            try:
                cleanup()
            except Exception as exc:
                error = error or f"cleanup {type(exc).__name__}: {exc}"
    if controller.error is not None:
        error = error or str(controller.error)
    report = evaluator.report()
    report.update(
        type="evaluation_report",
        source_kind=session.source_kind,
        run_error=error,
        elapsed_s=time.monotonic() - started,
        streaming_stats=controller.get_stats().__dict__,
        streaming_stats_note="Owner acquisition_overflow includes normal rolling-buffer eviction.",
    )
    emit(report)
    return report


def private_output(path):
    """Persist participant-derived output only in ignored workspace storage."""
    root = Path(__file__).resolve().parents[1]
    resolved = path.resolve()
    if not any(resolved.is_relative_to(root / name) for name in ("data", ".local")):
        raise ValueError("output must be inside this checkout's ignored data/ or .local/")
    resolved.parent.mkdir(parents=True, exist_ok=True)
    return resolved


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument(
        "--mock", action="store_true", help="paced synthetic plumbing run; no attention model"
    )
    source.add_argument("--pipeline-factory", help="module:factory returning an unconnected LiveSession")
    parser.add_argument("--duration-s", type=float, default=10)
    parser.add_argument("--window-s", type=float, default=2)
    parser.add_argument("--update-s", type=float, default=0.5)
    parser.add_argument("--stale-s", type=float, default=1)
    parser.add_argument("--warmup-s", type=float, default=10)
    parser.add_argument("--threshold", type=float, default=50)
    parser.add_argument("--session-id", default=uuid4().hex)
    parser.add_argument("--labels", type=Path, help="independent annotations JSON with matching session_id")
    parser.add_argument("--output", type=Path, help="JSONL journal under ignored data/ or .local/")
    args = parser.parse_args()
    labels = []
    try:
        if args.labels:
            payload = json.loads(args.labels.read_text(encoding="utf-8"))
            if payload["session_id"] != args.session_id:
                raise ValueError("label session_id does not match this run")
            labels = [AttentionLabel(**item) for item in payload["intervals"]]
        path = private_output(args.output) if args.output else None
        if args.mock:
            session = mock_session()
        else:
            module, separator, name = args.pipeline_factory.partition(":")
            if not separator or not module or not name:
                raise ValueError("pipeline factory must be module:callable")
            session = getattr(importlib.import_module(module), name)()
            if not isinstance(session, LiveSession):
                raise ValueError("factory must return LiveSession")
        # Never overwrite a previous participant/session journal.
        journal = path.open("x", encoding="utf-8") if path else None
        try:

            def emit(row):
                line = json.dumps(row, allow_nan=False)
                print(line, flush=True)
                if journal:
                    journal.write(line + "\n")
                    journal.flush()

            report = run_session(
                session,
                duration_s=args.duration_s,
                window_s=args.window_s,
                update_s=args.update_s,
                stale_s=args.stale_s,
                warmup_s=args.warmup_s,
                threshold=args.threshold,
                session_id=args.session_id,
                labels=labels,
                emit=emit,
            )
        finally:
            if journal:
                journal.close()
    except (ValueError, OSError, KeyError) as exc:
        parser.error(str(exc))
    return 1 if report["run_error"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
