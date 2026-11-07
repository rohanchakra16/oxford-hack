"""Loopback evaluation bridge for the existing lecture player; no live sensor mode.

Only media metadata reaches this service. Synthetic scores, or optional offline
workload scores, exercise the Python lecture evaluator on actual player progress.
"""

import argparse
import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Literal
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

from inference.lecture import LecturePrototype
from inference.lecture_types import (
    DemoEvidence,
    LectureConfig,
    MediaRange,
    PlaybackTick,
)

ROOT = Path(__file__).resolve().parents[1]
CONSERVATIVE = ROOT / "inference/bundles/lecture-conservative-0.1.0.json"
PLAYER_SCENARIO = Path(__file__).parent / "fixtures/player-smoke-scenario.json"


class Request(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Start(Request):
    videoId: str = Field(min_length=1, max_length=128)
    durationS: float = Field(gt=0)


class Progress(Request):
    seq: int = Field(ge=0)
    mediaS: float = Field(ge=0)
    state: Literal["playing", "paused", "seeking", "buffering", "ended"]
    playbackRate: float = Field(default=1, gt=0, le=4)
    replaying: bool = False


@dataclass
class PlayerSession:
    engine: LecturePrototype
    previous: Progress | None = None
    previous_ms: float = 0.0
    epoch: int = 0
    eligible_ms: float = 0.0
    touched: float = 0.0


def create_app(
    *, config=None, scenario=None, workload=None, clock=time.monotonic
) -> FastAPI:
    """Inject a clock for deterministic transport tests; never take browser clocks."""
    config = config or LectureConfig.model_validate_json(CONSERVATIVE.read_text())
    if config.mode != "normal":
        raise ValueError(
            "This player evaluation view supports normal-mode review reminders only."
        )
    scenario = scenario or json.loads(PLAYER_SCENARIO.read_text())
    windows = None
    if workload is not None:
        from evaluation.lecture_replay import workload_ticks

        windows = [tick.evidence for tick in workload_ticks(workload) if tick.evidence]
    app = FastAPI(title="Lecture player evaluation (prototype)")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://127.0.0.1:15174", "http://localhost:15174"],
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["content-type"],
    )
    sessions: dict[str, PlayerSession] = {}

    def source_score(start, end):
        if windows is not None:
            # An explicit hypothetical media timeline, NOT a cross-clock mapping.
            covered = [
                (
                    w,
                    max(
                        0,
                        min(end, w.media_range.end_media_s)
                        - max(start, w.media_range.start_media_s),
                    ),
                )
                for w in windows
            ]
            covered = [(w, width) for w, width in covered if width > 0]
            width = sum(width for _, width in covered)
            if (
                not covered
                or width < end - start - 1e-6
                or any(not w.usable or w.score is None for w, _ in covered)
            ):
                return None, False
            return sum(w.score * width for w, width in covered) / width, True
        if any(
            b["start_s"] < end and start < b["end_s"]
            for b in scenario.get("unknown_blocks", [])
        ):
            return None, False
        score = scenario.get("baseline_score", 0.9)
        # Require the complete observed window to fit a scripted low block.
        for block in scenario["score_blocks"]:
            if block["start_s"] <= start and end <= block["end_s"]:
                score = block["score"]
        return score, True

    def get_session(sid):
        if sid not in sessions:
            raise HTTPException(404, "Evaluation session expired; reload the lecture.")
        session = sessions[sid]
        session.touched = clock()
        return session

    def snapshot(session, events):
        engine = session.engine
        return {
            "prototype": True,
            "source": "eegmat_demo" if windows is not None else "synthetic",
            "sessionId": engine.session_id,
            "videoId": engine.video_id,
            "status": engine.status,
            "segments": [
                s.model_dump(mode="json", by_alias=True)
                for s in engine.segments.values()
            ],
            "events": events,
            "config": config.model_dump(mode="json", by_alias=True),
        }

    @app.get("/health")
    def health():
        return {"ok": True, "prototype": True, "liveAutomatic": False}

    @app.post("/sessions")
    def start(body: Start):
        now = clock()
        for sid in list(sessions):
            if now - sessions[sid].touched > 3600:
                del sessions[sid]
        if len(sessions) >= 20:
            raise HTTPException(
                429, "Too many evaluation sessions; close an unused tab."
            )
        engine = LecturePrototype(
            uuid4().hex, body.videoId, body.durationS, config=config
        )
        session = PlayerSession(engine, touched=now)
        sessions[engine.session_id] = session
        return snapshot(session, [])

    @app.delete("/sessions/{sid}")
    def close(sid: str):
        sessions.pop(sid, None)
        return {"closed": True}

    @app.post("/sessions/{sid}/tick")
    def tick(sid: str, body: Progress):
        session = get_session(sid)
        engine, previous = session.engine, session.previous
        now = clock() * 1000
        if body.mediaS > engine.duration_s:
            raise HTTPException(422, "Playback exceeds lecture duration.")
        if body.seq <= engine._seq:
            return snapshot(session, [])
        events = []
        evidence = None
        continuous = (
            previous is not None
            and previous.state == body.state == "playing"
            and not previous.replaying
            and not body.replaying
            and previous.playbackRate == body.playbackRate
        )
        delta = body.mediaS - previous.mediaS if previous else 0
        elapsed = now - session.previous_ms
        if continuous and (
            delta < 0 or abs(delta / body.playbackRate * 1000 - elapsed) > 350
        ):
            continuous = False  # missed seek/discontinuity: start a fresh epoch
        if body.state == "playing" and not continuous:
            session.epoch += 1
            session.eligible_ms = now
        if continuous and delta > 0:
            # Pre-mapped DEMO span follows observed player progress at its current rate.
            start_ms = max(session.eligible_ms, now - delta / body.playbackRate * 1000)
            start_s = body.mediaS - (now - start_ms) * body.playbackRate / 1000
            score, usable = source_score(start_s, body.mediaS)
            evidence = DemoEvidence(
                evidence_id=f"player-{body.seq}",
                start_backend_ms=start_ms,
                end_backend_ms=now,
                media_range=MediaRange(
                    start_media_s=max(0, start_s), end_media_s=body.mediaS
                ),
                score=score,
                usable=usable,
                source="eegmat_demo" if windows is not None else "synthetic",
                mapping_source="eegmat_demo_timeline"
                if windows is not None
                else "synthetic_fixture",
            )
        playing = body.state == "playing"
        events += engine.advance(
            PlaybackTick(
                session_id=sid,
                video_id=engine.video_id,
                duration_s=engine.duration_s,
                seq=body.seq,
                backend_ms=now,
                media_s=body.mediaS,
                state=body.state,
                playback_rate=body.playbackRate,
                replaying=body.replaying,
                segment_id=f"player-{session.epoch}" if playing else None,
                eligible_since_backend_ms=session.eligible_ms if playing else None,
                evidence=evidence,
            )
        )
        session.previous, session.previous_ms = body, now
        return snapshot(session, events)

    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=18766)
    parser.add_argument("--config", type=Path, default=CONSERVATIVE)
    parser.add_argument("--workload-json", type=Path)
    args = parser.parse_args()
    import uvicorn

    uvicorn.run(
        create_app(
            config=LectureConfig.model_validate_json(args.config.read_text()),
            workload=json.loads(args.workload_json.read_text(encoding="utf-8-sig"))
            if args.workload_json
            else None,
        ),
        host="127.0.0.1",
        port=args.port,
    )


if __name__ == "__main__":
    main()
