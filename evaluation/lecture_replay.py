"""Reproducible lecture demo/evaluation, with no sensors, video or API required."""

import argparse
import json
from itertools import pairwise
from pathlib import Path

from inference.lecture import LecturePrototype
from inference.lecture_types import (
    DemoEvidence,
    LectureConfig,
    MediaRange,
    PlaybackTick,
    QuestionAction,
    TranscriptExcerpt,
)

FIXTURE = Path(__file__).parent / "fixtures" / "lecture-scenario.json"
MODES = ("normal", "educational-immediate", "educational-end")


def mode_config(mode: str, overrides: dict | None = None) -> LectureConfig:
    values = dict(overrides or {})
    values.update(
        mode="normal" if mode == "normal" else "educational",
        question_timing="end_of_lecture" if mode == "educational-end" else "immediate",
    )
    if mode not in MODES:
        raise ValueError("unknown viewing mode")
    return LectureConfig.model_validate(values)


def synthetic_ticks(spec: dict) -> list[PlaybackTick]:
    """An explicitly scripted one-second fixture timeline, not a clock mapper."""
    duration = float(spec["duration_s"])
    ticks = []
    for second in range(1, int(duration) + 1):
        score = float(spec.get("baseline_score", 0.9))
        for block in spec["score_blocks"]:
            if block["start_s"] <= second < block["end_s"]:
                score = float(block["score"])
        usable = not any(b["start_s"] <= second < b["end_s"] for b in spec.get("unknown_blocks", []))
        ticks.append(
            PlaybackTick(
                session_id="demo-session",
                video_id="demo-lecture",
                seq=second,
                backend_ms=second * 1000.0,
                media_s=float(second),
                duration_s=duration,
                state="playing",
                segment_id="demo-playback-1",
                eligible_since_backend_ms=0.0,
                evidence=DemoEvidence(
                    evidence_id=f"synthetic-{second}",
                    start_backend_ms=(second - 1) * 1000.0,
                    end_backend_ms=second * 1000.0,
                    media_range=MediaRange(start_media_s=second - 1.0, end_media_s=float(second)),
                    score=score if usable else None,
                    usable=usable,
                ),
            )
        )
    ticks.append(
        PlaybackTick(
            session_id="demo-session",
            video_id="demo-lecture",
            seq=len(ticks) + 1,
            backend_ms=duration * 1000 + 1,
            media_s=duration,
            duration_s=duration,
            state="ended",
        )
    )
    return ticks


def workload_ticks(payload: dict) -> list[PlaybackTick]:
    """Hypothetical demo only: p(arithmetic) -> prototype score, with a fake lecture.

    No claim that arithmetic means attentive or rest means inattentive. Input is
    the JSON output of inference.workload_cli, not raw/private EEG recordings.
    """
    if payload.get("target") != "mental_arithmetic_vs_rest" or payload.get("live_automatic") is not False:
        raise ValueError("expected explicitly disabled EEGMAT workload CLI output")
    windows = payload["windows"]
    if not windows:
        raise ValueError("workload output contains no windows")
    if any("start_device_s" not in window or "end_device_s" not in window for window in windows):
        raise ValueError("workload demo needs explicit timestamp ranges, including for unknown windows")
    origin = float(windows[0]["start_device_s"])
    duration = float(windows[-1]["end_device_s"]) - origin
    ticks = []
    previous_end = 0.0
    for i, window in enumerate(windows, 1):
        start = float(window["start_device_s"]) - origin
        end = float(window["end_device_s"]) - origin
        if start < previous_end or end <= start:
            raise ValueError("workload demo windows must be ordered and non-overlapping")
        previous_end = end
        prediction = window["prediction"]
        usable = prediction["state"] == "ok" and prediction.get("score") is not None
        ticks.append(
            PlaybackTick(
                session_id="eegmat-demo-session",
                video_id="eegmat-fake-lecture",
                seq=i,
                backend_ms=end * 1000,
                media_s=end,
                duration_s=duration,
                state="playing",
                segment_id="eegmat-demo-playback",
                eligible_since_backend_ms=0.0,
                evidence=DemoEvidence(
                    evidence_id=f"eegmat-demo-{i}",
                    start_backend_ms=start * 1000,
                    end_backend_ms=end * 1000,
                    media_range=MediaRange(start_media_s=start, end_media_s=end),
                    source="eegmat_demo",
                    mapping_source="eegmat_demo_timeline",
                    score=prediction.get("score") if usable else None,
                    usable=usable,
                ),
            )
        )
    ticks.append(
        PlaybackTick(
            session_id=ticks[0].session_id,
            video_id=ticks[0].video_id,
            seq=len(ticks) + 1,
            backend_ms=duration * 1000 + 1,
            media_s=duration,
            duration_s=duration,
            state="ended",
        )
    )
    return ticks


def run_replay(
    ticks: list[PlaybackTick],
    config: LectureConfig,
    *,
    transcript: list[TranscriptExcerpt] | None = None,
    auto_resolve=True,
) -> tuple[dict, LecturePrototype]:
    if not ticks:
        raise ValueError("replay has no ticks")
    first = ticks[0]
    engine = LecturePrototype(
        first.session_id, first.video_id, first.duration_s, config=config, transcript=transcript
    )
    events = []

    def accept(batch):
        events.extend(batch)
        if auto_resolve:
            for event in batch:
                if event["type"] == "question_request":
                    question_id = event["payload"]["questionId"]
                    events.extend(
                        engine.act(
                            QuestionAction(
                                action_id=f"shown-{question_id}",
                                question_id=question_id,
                                backend_ms=engine.now,
                                action="presented",
                            )
                        )
                    )
                    # Scripted answers exercise scheduling, not question correctness.
                    events.extend(
                        engine.act(
                            QuestionAction(
                                action_id=f"answer-{question_id}",
                                question_id=question_id,
                                backend_ms=engine.now,
                                action="answer",
                                answer="Demo response",
                            )
                        )
                    )

    for tick in ticks:
        accept(engine.advance(tick))
    if auto_resolve and engine.ended:
        while engine.questions.pending:
            accept(engine.poll(engine.now + config.question_cooldown_ms))
    estimates = [e["payload"] for e in events if e["type"] == "attention_estimate"]
    prompt_times = [q.requested_backend_ms for q in engine.questions.requests.values()]
    intervals = [b - a for a, b in pairwise(prompt_times)]
    elapsed_minutes = max(engine.now - ticks[0].backend_ms, 1.0) / 60000
    levels = {
        level: sum(e["level"] == level for e in estimates)
        for level in ("high attention", "medium attention", "low attention", "no attention", "unknown")
    }
    report = {
        "prototype": True,
        "source": sorted({t.evidence.source for t in ticks if t.evidence}),
        "mode": config.mode,
        "question_timing": config.question_timing,
        "config": config.model_dump(mode="json", by_alias=True),
        "metrics": {
            "review_segments": len(engine.segments),
            "qualifying_episodes": engine.qualifications,
            "merged_episodes": engine.qualifications - len(engine.segments),
            "question_requests": len(prompt_times),
            "minimum_prompt_interval_ms": min(intervals) if intervals else None,
            "prompts_per_elapsed_minute": len(prompt_times) / elapsed_minutes,
            "prompt_window_elapsed_minutes": elapsed_minutes,
            "attention_estimate_counts": levels,
            "detection_accuracy": None,
            "false_positive_rate": None,
            "reference_label_limit": "No independent attention labels; counts and scheduling checks only.",
        },
        "segments": [s.model_dump(mode="json", by_alias=True) for s in engine.segments.values()],
        "questions": [q.model_dump(mode="json", by_alias=True) for q in engine.questions.requests.values()],
        "events": events,
    }
    return report, engine


def suite_report() -> dict:
    primary = json.loads(FIXTURE.read_text(encoding="utf-8"))
    scenarios = {
        "attention_bouts": primary,
        "steady_high": dict(primary, score_blocks=[], unknown_blocks=[]),
        "unusable_signal": dict(
            primary, baseline_score=0.0, score_blocks=[], unknown_blocks=[{"start_s": 0, "end_s": 121}]
        ),
    }
    cases = []
    example = None
    for name, spec in scenarios.items():
        transcript = [TranscriptExcerpt.model_validate(x) for x in spec["transcript"]]
        for mode in MODES:
            report, _ = run_replay(synthetic_ticks(spec), mode_config(mode), transcript=transcript)
            cases.append({"scenario": name, "mode": mode, "metrics": report["metrics"]})
            if name == "attention_bouts" and mode == "educational-immediate":
                example = next(event for event in report["events"] if event["type"] == "question_request")
    return {
        "prototype": True,
        "source": "synthetic",
        "version": "0.1.0",
        "cases": cases,
        "example_question_request": example,
        "limitations": (
            "Scripted behaviour only. No attention ground truth, accuracy or false-positive estimate."
        ),
    }


def interactive(engine: LecturePrototype) -> None:
    print(
        "Prototype terminal: list | answer <text> | dismiss | replay [segment-id] "
        "| complete-replay | next | quit"
    )
    print("Replay emits a PlayerHandle command; this terminal does not open or control a video.")
    while True:
        question_id = engine.questions.active_id
        if question_id and engine.questions.states[question_id] == "requested":
            engine.act(
                QuestionAction(
                    action_id=f"terminal-shown-{question_id}",
                    question_id=question_id,
                    backend_ms=engine.now,
                    action="presented",
                )
            )
        if question_id:
            print(engine.questions.requests[question_id].question_text)
        command = input("> ").strip()
        if command == "quit":
            return
        if command == "list":
            for segment in engine.segments.values():
                print(segment.segment_id, segment.media_range, segment.attention_level)
            continue
        engine.now += 1.0
        if command == "complete-replay":
            engine.advance(
                PlaybackTick(
                    session_id=engine.session_id,
                    video_id=engine.video_id,
                    seq=engine._seq + 1,
                    backend_ms=engine.now,
                    media_s=engine.duration_s,
                    duration_s=engine.duration_s,
                    state="paused",
                    replaying=False,
                )
            )
            print("Demo replay completion acknowledged.")
            continue
        if command == "next":
            engine.poll(engine.now + engine.config.question_cooldown_ms)
            continue
        action, _, answer = command.partition(" ")
        if action == "replay" and answer:
            try:
                print(
                    json.dumps(engine.request_replay(answer, f"terminal-{engine.now}", engine.now), indent=2)
                )
            except (ValueError, KeyError) as error:
                print(error)
            continue
        if question_id and action in ("answer", "dismiss", "replay"):
            try:
                events = engine.act(
                    QuestionAction(
                        action_id=f"terminal-{engine.now}",
                        question_id=question_id,
                        backend_ms=engine.now,
                        action=action,
                        answer=answer if action == "answer" else None,
                    )
                )
                print(json.dumps(events, indent=2))
                if action == "replay":
                    print("Command only. Player integration must report replaying until actual replay ends.")
            except ValueError as error:
                print(error)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", type=Path, default=FIXTURE)
    parser.add_argument("--workload-json", type=Path)
    parser.add_argument("--mode", choices=MODES, default="normal")
    parser.add_argument(
        "--config", type=Path, help="JSON LectureConfig thresholds/smoothing; mode comes from --mode"
    )
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--interactive", action="store_true")
    parser.add_argument(
        "--suite", action="store_true", help="JSON summary for three scenarios in all viewing modes"
    )
    parser.add_argument(
        "--write-artifacts", action="store_true", help="regenerate owned synthetic report/example fixtures"
    )
    args = parser.parse_args()
    if args.suite or args.write_artifacts:
        report = suite_report()
        if args.write_artifacts:
            output = Path(__file__).parent / "fixtures"
            (output / "lecture-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
            (output / "lecture-question-request.json").write_text(
                json.dumps(report["example_question_request"], indent=2) + "\n", encoding="utf-8"
            )
        print(json.dumps(report, indent=2, allow_nan=False))
        return
    spec = json.loads(args.scenario.read_text(encoding="utf-8"))
    ticks = (
        workload_ticks(json.loads(args.workload_json.read_text(encoding="utf-8")))
        if args.workload_json
        else synthetic_ticks(spec)
    )
    overrides = json.loads(args.config.read_text(encoding="utf-8")) if args.config else {}
    transcript = (
        [] if args.workload_json else [TranscriptExcerpt.model_validate(x) for x in spec["transcript"]]
    )
    report, engine = run_replay(
        ticks, mode_config(args.mode, overrides), transcript=transcript, auto_resolve=not args.interactive
    )
    if args.json:
        print(json.dumps(report, indent=2, allow_nan=False))
    else:
        print("PROTOTYPE DEMO - synthetic/hypothetical estimates; not validated attention")
        print(json.dumps(report["metrics"], indent=2))
        print("REVIEW RANGE (media seconds) | ESTIMATE | REMINDER")
        for segment in engine.segments.values():
            span = segment.media_range
            print(
                f"{span.start_media_s:g}-{span.end_media_s:g}s | {segment.attention_level} "
                "| Review this segment"
            )
        for question in engine.questions.requests.values():
            print(question.question_id, question.question_text)
    if args.interactive:
        interactive(engine)


if __name__ == "__main__":
    main()
