"""Prototype-local API, NOT a new message in the platform's shared wire schema."""

from typing import Literal

from oxford_hack.contracts.base import BackendMs, Contract, Id, MediaS
from pydantic import Field, model_validator

AttentionLevel = Literal["high attention", "medium attention", "low attention", "no attention", "unknown"]
Source = Literal["synthetic", "eegmat_demo"]


class LectureConfig(Contract):
    version: Literal["0.1.0"] = "0.1.0"
    mode: Literal["normal", "educational"] = "normal"
    question_timing: Literal["immediate", "end_of_lecture"] = "immediate"
    no_attention_max: float = Field(default=0.2, ge=0, le=1)
    low_attention_max: float = Field(default=0.4, ge=0, le=1)
    medium_attention_max: float = Field(default=0.7, ge=0, le=1)
    recovery_min: float = Field(default=0.5, ge=0, le=1)
    smoothing_tau_ms: float = Field(default=2000.0, ge=0)
    minimum_loss_ms: float = Field(default=4000.0, gt=0)
    recovery_ms: float = Field(default=2000.0, ge=0)
    merge_gap_s: float = Field(default=5.0, ge=0)
    max_evidence_step_ms: float = Field(default=5000.0, gt=0)
    stale_after_ms: float = Field(default=2000.0, gt=0)
    question_cooldown_ms: float = Field(default=30000.0, ge=30000)

    @model_validator(mode="after")
    def ordered_thresholds(self) -> "LectureConfig":
        if not self.no_attention_max < self.low_attention_max < self.medium_attention_max:
            raise ValueError("attention thresholds must be strictly increasing")
        if self.recovery_min <= self.low_attention_max:
            raise ValueError("recovery must exceed the loss threshold (hysteresis)")
        return self


class MediaRange(Contract):
    start_media_s: MediaS
    end_media_s: MediaS

    @model_validator(mode="after")
    def ordered(self) -> "MediaRange":
        if self.end_media_s <= self.start_media_s:
            raise ValueError("media range must have positive duration")
        return self


class TranscriptExcerpt(MediaRange):
    text: str = Field(min_length=1, max_length=500)


class DemoEvidence(Contract):
    evidence_id: Id
    start_backend_ms: BackendMs
    end_backend_ms: BackendMs
    media_range: MediaRange
    source: Source = "synthetic"
    mapping_source: Literal["synthetic_fixture", "eegmat_demo_timeline"] = "synthetic_fixture"
    score: float | None = Field(default=None, ge=0, le=1)
    usable: bool = True

    @model_validator(mode="after")
    def valid_interval(self) -> "DemoEvidence":
        if self.end_backend_ms <= self.start_backend_ms:
            raise ValueError("evidence interval must have positive duration")
        if (self.source == "eegmat_demo") != (self.mapping_source == "eegmat_demo_timeline"):
            raise ValueError("source and demo timeline provenance must agree")
        return self


class PlaybackTick(Contract):
    session_id: Id
    video_id: Id
    seq: int = Field(ge=0)
    backend_ms: BackendMs
    media_s: MediaS
    duration_s: float = Field(gt=0)
    state: Literal["playing", "paused", "seeking", "buffering", "ended"]
    segment_id: Id | None = None
    eligible_since_backend_ms: BackendMs | None = None
    replaying: bool = False
    playback_rate: float = Field(default=1.0, gt=0, le=16)
    evidence: DemoEvidence | None = None

    @model_validator(mode="after")
    def coherent_playback(self) -> "PlaybackTick":
        playing = self.state == "playing"
        if playing != (self.segment_id is not None and self.eligible_since_backend_ms is not None):
            raise ValueError("playing needs a segment and eligibility start")
        if not playing and (self.segment_id is not None or self.eligible_since_backend_ms is not None):
            raise ValueError("non-playing ticks must clear segment/eligibility")
        if self.media_s > self.duration_s:
            raise ValueError("playback position exceeds lecture duration")
        if self.eligible_since_backend_ms is not None and self.eligible_since_backend_ms > self.backend_ms:
            raise ValueError("eligibility cannot start in the future")
        return self


class ReviewSegment(Contract):
    segment_id: Id
    session_id: Id
    video_id: Id
    lecture_revision: Id
    config_version: Literal["0.1.0"] = "0.1.0"
    config_fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")
    media_range: MediaRange
    attention_level: Literal["low attention", "no attention"]
    trigger_reason: Literal["sustained_low_estimate"] = "sustained_low_estimate"
    source: Source
    prototype: Literal[True] = True
    first_detected_backend_ms: BackendMs
    last_evidence_backend_ms: BackendMs
    continuity_id: int
    revision: int = 1
    episode_count: int = 1
    closed: bool = False


class QuestionRequest(Contract):
    question_id: Id
    segment_id: Id
    session_id: Id
    video_id: Id
    lecture_revision: Id
    config_version: Literal["0.1.0"] = "0.1.0"
    config_fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")
    affected_range: MediaRange
    attention_level: Literal["low attention", "no attention"]
    trigger_reason: Literal["sustained_low_estimate"] = "sustained_low_estimate"
    transcript_context: list[TranscriptExcerpt]
    requested_backend_ms: BackendMs
    timing: Literal["immediate", "end_of_lecture"]
    source: Source
    prototype: Literal[True] = True
    placeholder: Literal[True] = True
    question_text: str = Field(min_length=1, max_length=2000)
    pause_playback: Literal[False] = False


class QuestionAction(Contract):
    action_id: Id
    question_id: Id
    backend_ms: BackendMs
    action: Literal["presented", "answer", "dismiss", "replay"]
    answer: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def answer_required(self) -> "QuestionAction":
        if self.action == "answer" and (self.answer is None or not self.answer.strip()):
            raise ValueError("answer action requires nonempty text")
        if self.action != "answer" and self.answer is not None:
            raise ValueError("only answer actions carry answer text")
        return self
