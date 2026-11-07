"""Message payloads. Each class docstring states sender, receiver, owner and time base.

PROPOSED v0.1.0: not yet agreed by the team. See contracts/README.md.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field, model_validator

from .base import (
    AutomaticMode,
    BackendMs,
    BrowserMs,
    Contract,
    Count,
    DeviceS,
    DurationMs,
    Id,
    Label,
    MediaS,
    OperatingMode,
    RunKind,
    ShortText,
)
from .base import (
    BackendInterval as BackendInterval,
)
from .base import (
    MediaInterval as MediaInterval,
)
from .base import (
    Provenance as Provenance,
)

# --------------------------------------------------------------------------------------------
# Connection, session and errors (owner: Person 5)
# --------------------------------------------------------------------------------------------


class ResumeRequest(Contract):
    session_id: Id
    backend_instance_id: Id = Field(description="Backend instance the browser last talked to.")
    last_received_seq: Count = Field(description="Highest server seq the browser processed.")


class ClientCapabilities(Contract):
    playback_telemetry: bool
    gaze: bool
    diagnostics: bool


class ClientHello(Contract):
    """First message on every WebSocket. Browser -> backend. Owner: P5.

    ``sessionToken`` comes from POST /api/v0/handshake and is bound to ``clientInstanceId``.
    """

    client_instance_id: Id = Field(description="Random per page load; a reload is a new client.")
    session_token: Annotated[str, Field(min_length=16, max_length=256)]
    resume: ResumeRequest | None
    capabilities: ClientCapabilities
    t_browser_ms: BrowserMs


ResumeOutcome = Literal["new", "resumed", "backend_restarted", "session_expired", "session_unknown"]


class ServerHello(Contract):
    """Reply to ClientHello. Backend -> browser. Owner: P5.

    ``backend_restarted`` means every backend-clock timestamp and segment the browser knew is void:
    start a new session. ``resumed`` is followed by a SessionSnapshot.
    """

    backend_instance_id: Id
    connection_id: Id
    resume_outcome: ResumeOutcome
    session_id: Id | None
    heartbeat_interval_ms: DurationMs
    heartbeat_timeout_ms: DurationMs
    t_backend_ms: BackendMs


class Heartbeat(Contract):
    """Liveness. Either direction. ``clock`` names the sender's clock. Owner: P5."""

    clock: Literal["browser", "backend"]
    sent_ms: Annotated[float, Field(ge=0)]


class ClockPing(Contract):
    """Backend -> browser. The browser must answer immediately with ClockPong. Owner: P5."""

    ping_id: Id
    t_backend_send_ms: BackendMs


class ClockPong(Contract):
    """Browser -> backend. Echoes the ping and adds browser receive/send times. Owner: P5."""

    ping_id: Id
    t_backend_send_ms: BackendMs
    t_browser_recv_ms: BrowserMs
    t_browser_send_ms: BrowserMs

    @model_validator(mode="after")
    def _ordered(self) -> ClockPong:
        if self.t_browser_send_ms < self.t_browser_recv_ms:
            raise ValueError("tBrowserSendMs must be >= tBrowserRecvMs")
        return self


ClockState = Literal["unsynchronised", "synchronised", "degraded"]


class ClockStatus(Contract):
    """Backend -> browser (diagnostics). Estimate of browser-minus-backend offset. Owner: P5.

    browserMs = backendMs + offsetBrowserMinusBackendMs (+/- uncertaintyMs).
    """

    state: ClockState
    offset_browser_minus_backend_ms: float | None
    uncertainty_ms: Annotated[float, Field(ge=0)] | None
    best_rtt_ms: Annotated[float, Field(ge=0)] | None
    sample_count: Count
    t_backend_ms: BackendMs

    @model_validator(mode="after")
    def _nulls(self) -> ClockStatus:
        missing = self.offset_browser_minus_backend_ms is None
        if missing != (self.uncertainty_ms is None):
            raise ValueError("offset and uncertainty must both be null or both be set")
        if self.state != "unsynchronised" and missing:
            raise ValueError("a synchronised/degraded clock must report offset and uncertainty")
        return self


class RequestedSensors(Contract):
    eeg: bool
    gaze: bool


class SessionStart(Contract):
    """Browser -> backend: start a session for one video. Owner: P5 (sent by P4's player).

    One session = one video. To change video, send SessionEnd then a new SessionStart.
    """

    video_id: Id
    run_kind: RunKind
    requested_sensors: RequestedSensors
    media_duration_s: Annotated[float, Field(gt=0)] | None


class SessionEnd(Contract):
    """Browser -> backend. Owner: P5."""

    reason: Literal["user_ended", "video_changed", "page_closing"]


class DetectorInfo(Contract):
    """Identity of the experimental detector (P3's model bundle)."""

    detector_id: Id
    detector_version: Label
    config_version: Label


ModePolicyValue = Literal["automatic", "manual_only"]


class ModePolicy(Contract):
    """Which operating modes may produce automatic suggestions.

    A mode is ``automatic`` if evaluated, simulated, or explicitly enabled by the local operator
    for an experimental live detector. Experimental opt-in is not evaluation evidence and is
    reported in sensor-status reasons and detector identity. Otherwise the mode is manual-only.
    """

    both: ModePolicyValue
    eeg_only: ModePolicyValue
    gaze_only: ModePolicyValue


class EegDeviceInfo(Contract):
    """Device metadata as reported by P1's adapter. Unconfirmed values stay null."""

    model: Label | None
    confirmed: bool = Field(description="True only once P1 has verified this against the device.")
    sample_rate_hz: Annotated[float, Field(gt=0)] | None
    channel_names: list[Label] | None
    units: Label | None


class MappingConfig(Contract):
    lead_in_s: Annotated[float, Field(ge=0, le=60)]
    boundary_margin_ms: DurationMs
    max_clock_uncertainty_ms: DurationMs
    max_telemetry_staleness_ms: DurationMs
    pending_timeout_ms: DurationMs
    max_candidate_age_ms: DurationMs


class SessionConfig(Contract):
    """Backend -> browser: authoritative session configuration. Owner: P5."""

    session_id: Id
    video_id: Id
    run_kind: RunKind
    enabled_sensors: RequestedSensors
    mode_policy: ModePolicy
    detector: DetectorInfo | None
    eeg_device: EegDeviceInfo | None
    feature_set_version: Label | None
    mapping: MappingConfig
    created_backend_ms: BackendMs


class SessionEnded(Contract):
    """Backend -> browser. Owner: P5."""

    reason: Literal["client_ended", "expired", "superseded", "backend_shutdown"]


ErrorCode = Literal[
    "invalid_json",
    "invalid_message",
    "schema_version_mismatch",
    "unknown_type",
    "unexpected_type",
    "message_too_large",
    "not_authenticated",
    "no_session",
    "obsolete_session",
    "video_mismatch",
    "out_of_order",
    "duplicate",
    "stale",
    "rate_limited",
    "backpressure",
    "internal",
]


class ErrorReport(Contract):
    """Either direction. Never contains signal values. Owner: P5."""

    code: ErrorCode
    message: ShortText
    ref_message_id: Id | None
    fatal: bool
    details: dict[Annotated[str, Field(max_length=64)], str | int | float | bool | None]


# --------------------------------------------------------------------------------------------
# Playback (telemetry owner: Person 4; contract and mapping owner: Person 5)
# --------------------------------------------------------------------------------------------

PlaybackEvent = Literal[
    "load",
    "playing",
    "pause",
    "seeking",
    "seeked",
    "waiting",
    "ratechange",
    "source_change",
    "ended",
    "heartbeat",
    "error",
]
PlaybackStateName = Literal["loading", "playing", "paused", "seeking", "buffering", "ended", "error"]


class PlaybackState(Contract):
    """Browser -> backend. Sent on every media event and every ~1 s while playing. Owner: P4 (P5 contract).

    ``segmentId`` is non-null exactly when ``state == "playing"``. A new segment id starts whenever
    frames start advancing after any interruption (pause, seek, buffering, rate change, source change).
    Within one segment ``playbackRate`` is constant. ``tBrowserMs`` is when the media element event
    was observed, not when the message was sent.
    """

    video_id: Id
    segment_id: Id | None
    event: PlaybackEvent
    state: PlaybackStateName
    t_browser_ms: BrowserMs
    media_time_s: MediaS
    playback_rate: Annotated[float, Field(gt=0, le=16)]
    media_duration_s: Annotated[float, Field(gt=0)] | None
    telemetry_seq: Count = Field(description="Monotonic per video within a page load.")
    replaying: bool = Field(
        default=False, description="Explicit review replay; never eligible for new reminders."
    )

    @model_validator(mode="after")
    def _segment(self) -> PlaybackState:
        if (self.state == "playing") != (self.segment_id is not None):
            raise ValueError("segmentId must be set if and only if state is 'playing'")
        return self


EligibilityReason = Literal[
    "playing",
    "not_started",
    "paused",
    "seeking",
    "buffering",
    "ended",
    "source_change",
    "error",
    "stale_telemetry",
    "clock_unsynchronised",
    "session_ended",
    "review_replay",
]


class PlaybackEligibility(Contract):
    """Backend -> inference (P3) and browser (diagnostics). Owner: P5.

    When ``eligible`` becomes false or ``segmentId`` changes, the detector must clear pending
    decisions and wait for a complete evidence window starting at or after ``eligibleSinceBackendMs``.
    This does NOT mean EEG filters should be reset (P1 keeps filter state continuous).
    ``epoch`` increases by one on every change.
    """

    video_id: Id
    segment_id: Id | None
    eligible: bool
    reason: EligibilityReason
    epoch: Count
    eligible_since_backend_ms: BackendMs | None
    t_backend_ms: BackendMs

    @model_validator(mode="after")
    def _consistent(self) -> PlaybackEligibility:
        if self.eligible != (self.segment_id is not None):
            raise ValueError("segmentId must be set if and only if eligible")
        if self.eligible != (self.eligible_since_backend_ms is not None):
            raise ValueError("eligibleSinceBackendMs must be set if and only if eligible")
        if self.eligible != (self.reason == "playing"):
            raise ValueError("reason must be 'playing' if and only if eligible")
        return self


# --------------------------------------------------------------------------------------------
# EEG (owner: Person 1). Backend-internal; never sent to the browser.
# --------------------------------------------------------------------------------------------

EegQualityFlag = Literal[
    "disconnected",
    "flatline",
    "clipping",
    "missing_samples",
    "poor_contact",
    "large_artifact",
    "settling",
    "gap_recovery",
    "units_unverified",
    "clock_uncertain",
]


class EegChannelQuality(Contract):
    channel: Label
    state: Literal["good", "poor", "bad", "unknown"]
    flags: list[EegQualityFlag]


class EegWindowQuality(Contract):
    """Quality checks reduce contamination; they do not prove remaining activity is neural."""

    usable: bool
    flags: list[EegQualityFlag]
    channels: list[EegChannelQuality]


class ClockCorrection(Contract):
    """How device time was converted to backend time (P1 applies it; P5 provides mappers)."""

    method: Literal["lsl_time_correction", "linear_fit", "same_clock", "fixed_offset"]
    offset_s: float | None
    drift_ppm: float | None
    uncertainty_ms: Annotated[float, Field(ge=0)] | None


class SampleCounts(Contract):
    expected: Count
    received: Count


class EegFeature(Contract):
    """One feature value. ``value`` null requires ``missingReason``; a valid zero is a real zero."""

    name: Label
    unit: Label
    channel: Label | None
    value: float | None
    missing_reason: ShortText | None

    @model_validator(mode="after")
    def _missing(self) -> EegFeature:
        if (self.value is None) == (self.missing_reason is None):
            raise ValueError("exactly one of value and missingReason must be set")
        return self


class EegFeatureWindow(Contract):
    """P1 -> backend hub -> P3. One complete, continuous window of features.

    ``evidence`` is the acquisition interval converted to backend time. ``deviceEvidence`` keeps the
    original device timestamps. ``tProcessedBackendMs`` is when features became available.
    """

    window_id: Id
    stream_id: Id
    feature_set_version: Label
    evidence: BackendInterval
    device_evidence_start_device_s: DeviceS | None
    device_evidence_end_device_s: DeviceS | None
    clock_correction: ClockCorrection
    samples: SampleCounts
    channels: list[Label]
    features: list[EegFeature]
    quality: EegWindowQuality
    t_processed_backend_ms: BackendMs
    provenance: Provenance

    @model_validator(mode="after")
    def _times(self) -> EegFeatureWindow:
        if self.t_processed_backend_ms < self.evidence.end_backend_ms:
            raise ValueError("tProcessedBackendMs must be >= evidence.endBackendMs")
        return self


SensorStateName = Literal["disabled", "unavailable", "connecting", "warming_up", "ok", "degraded", "lost"]


class EegStatus(Contract):
    """P1 -> backend hub. Stream-level status, sent on change and at least every 5 s."""

    stream_id: Id
    state: SensorStateName
    flags: list[EegQualityFlag]
    device: EegDeviceInfo
    dropped_packets: Count | None
    t_backend_ms: BackendMs
    provenance: Provenance


# --------------------------------------------------------------------------------------------
# Gaze (owner: Person 2). Browser -> backend. Raw frames never leave the browser.
# --------------------------------------------------------------------------------------------

GazeInvalidReason = Literal[
    "face_not_detected",
    "eyes_not_detected",
    "calibration_missing",
    "calibration_invalid",
    "low_confidence",
    "camera_unavailable",
    "video_not_visible",
    "tab_hidden",
    "frame_dropped",
]


class NormalisedPoint(Contract):
    """Point in the displayed video content rectangle. (0,0)=top-left, (1,1)=bottom-right.

    Values outside [0,1] are allowed and mean the estimate is outside the video.
    """

    x: Annotated[float, Field(ge=-10, le=10)]
    y: Annotated[float, Field(ge=-10, le=10)]


class GazeObservation(Contract):
    """One processed webcam frame. ``tBrowserFrameMs`` is when the frame was captured/observed.

    ``measurementKind`` must say ``head_direction`` if the model does not estimate screen gaze.
    ``insideVideo`` false is a valid observation ("looking outside video"), distinct from invalid.
    """

    observation_id: Id
    t_browser_frame_ms: BrowserMs
    t_browser_processed_ms: BrowserMs
    measurement_kind: Literal["screen_gaze", "head_direction"]
    calibration_id: Id | None
    valid: bool
    invalid_reasons: list[GazeInvalidReason]
    video_point: NormalisedPoint | None
    inside_video: bool | None
    model_confidence: Annotated[float, Field(ge=0, le=1)] | None = Field(
        description="Model-specific; not comparable with other models or with EEG scores."
    )

    @model_validator(mode="after")
    def _validity(self) -> GazeObservation:
        if self.t_browser_processed_ms < self.t_browser_frame_ms:
            raise ValueError("tBrowserProcessedMs must be >= tBrowserFrameMs")
        if self.valid:
            if self.invalid_reasons:
                raise ValueError("valid observations must have no invalidReasons")
            if self.video_point is None or self.inside_video is None:
                raise ValueError("valid observations need videoPoint and insideVideo")
        else:
            if not self.invalid_reasons:
                raise ValueError("invalid observations need at least one invalidReason")
            if self.video_point is not None or self.inside_video is not None:
                raise ValueError("invalid observations must have null videoPoint and insideVideo")
        return self


class GazeObservationBatch(Contract):
    """Browser -> backend, at most ~10 batches/s. Owner: P2."""

    observations: Annotated[list[GazeObservation], Field(min_length=1, max_length=64)]
    provenance: Provenance


class CssRect(Contract):
    x: float
    y: float
    width: Annotated[float, Field(gt=0)]
    height: Annotated[float, Field(gt=0)]


class GazeCalibration(Contract):
    """Browser -> backend, on every calibration state change. Owner: P2.

    Accuracy is measured on held-out points excluded from fitting.
    """

    calibration_id: Id
    status: Literal["in_progress", "valid", "invalid", "expired"]
    measurement_kind: Literal["screen_gaze", "head_direction"]
    method: Label
    fit_points: Count
    held_out_points: Count
    held_out_error_norm: Annotated[float, Field(ge=0)] | None = Field(
        description="Mean held-out error as a fraction of video width."
    )
    viewport_css_px: CssRect
    video_rect_css_px: CssRect
    invalidated_reason: ShortText | None
    t_browser_ms: BrowserMs
    provenance: Provenance


# --------------------------------------------------------------------------------------------
# Review candidates (owner: Person 3) and bookmarks (owner: Person 5)
# --------------------------------------------------------------------------------------------


class SignalScore(Contract):
    """A named score from one signal. Scores from different sources are not interchangeable."""

    name: Label
    value: float | None
    scale: Label = Field(description="e.g. 'logit', 'uncalibrated_probability', 'fraction_of_window'.")
    missing_reason: ShortText | None

    @model_validator(mode="after")
    def _missing(self) -> SignalScore:
        if (self.value is None) == (self.missing_reason is None):
            raise ValueError("exactly one of value and missingReason must be set")
        return self


class ContributingSignal(Contract):
    signal: Literal["eeg", "gaze"]
    window_ids: list[Id]
    scores: list[SignalScore]


class ReviewCandidate(Contract):
    """P3 detector -> P5 hub. Backend clock only: the detector never needs media time.

    ``evidence`` is the interval the decision is based on. ``decisionBackendMs`` is when it was made.
    ``eventId`` must be stable: re-sending the same event must reuse it (duplicates are dropped).
    ``eligibilityEpoch`` is the latest PlaybackEligibility.epoch the detector saw (diagnostic only).
    """

    event_id: Id
    detector: DetectorInfo
    mode: AutomaticMode
    evidence: BackendInterval
    decision_backend_ms: BackendMs
    eligibility_epoch: Count | None
    contributing_signals: Annotated[list[ContributingSignal], Field(min_length=1)]
    provenance: Provenance

    @model_validator(mode="after")
    def _times(self) -> ReviewCandidate:
        if self.decision_backend_ms < self.evidence.end_backend_ms:
            raise ValueError("decisionBackendMs must be >= evidence.endBackendMs")
        signals = {s.signal for s in self.contributing_signals}
        needed = {"both": {"eeg", "gaze"}, "eeg_only": {"eeg"}, "gaze_only": {"gaze"}}[self.mode]
        if signals != needed:
            raise ValueError(f"mode {self.mode} requires contributing signals {sorted(needed)}")
        return self


BookmarkSource = Literal["experimental_eeg", "experimental_gaze", "experimental_combined", "manual"]


class TranscriptContext(Contract):
    """Filled by the browser (P4) from its transcript; the backend always sends null."""

    text: ShortText
    start_media_s: MediaS
    end_media_s: MediaS


class ReviewBookmark(Contract):
    """Backend -> browser. A candidate mapped to media time by P5, or a manual bookmark. Owner: P5.

    ``suggestedMediaS`` is a conservative restart suggestion derived from the evidence interval,
    not a measured lapse onset. ``bookmarkId`` is stable per event, so clients can de-duplicate.
    """

    bookmark_id: Id
    event_id: Id | None
    video_id: Id
    segment_id: Id | None
    source: BookmarkSource
    run_kind: RunKind
    suggested_media_s: MediaS
    evidence_media: MediaInterval | None
    evidence: BackendInterval | None
    decision_backend_ms: BackendMs | None
    mapped_backend_ms: BackendMs
    mapping_uncertainty_ms: Annotated[float, Field(ge=0)] | None
    detector: DetectorInfo | None
    contributing_signals: list[ContributingSignal]
    transcript_context: TranscriptContext | None

    @model_validator(mode="after")
    def _source(self) -> ReviewBookmark:
        automatic = self.source != "manual"
        fields = (self.event_id, self.evidence_media, self.evidence, self.decision_backend_ms, self.detector)
        if automatic and any(f is None for f in fields):
            raise ValueError(
                "experimental bookmarks need eventId, evidence, evidenceMedia, decision and detector"
            )
        if not automatic and any(f is not None for f in fields):
            raise ValueError("manual bookmarks must not carry detector evidence")
        return self


class ManualBookmark(Contract):
    """Browser -> backend: the viewer pressed 'mark'. Owner: P4."""

    bookmark_id: Id
    video_id: Id
    media_time_s: MediaS
    t_browser_ms: BrowserMs


CandidateRejectionReason = Literal[
    "duplicate",
    "obsolete_session",
    "mode_not_automatic",
    "too_old",
    "clock_unsynchronised",
    "clock_uncertain",
    "not_playing",
    "crosses_boundary",
    "history_expired",
    "stale_telemetry",
    "video_mismatch",
    "out_of_media_bounds",
    "invalid",
]


class CandidateRejected(Contract):
    """Backend -> browser (diagnostics only). Owner: P5."""

    event_id: Id | None
    reason: CandidateRejectionReason
    detail: ShortText


FeedbackAction = Literal["replay", "dismiss", "move_earlier", "rated_useful", "rated_not_useful"]


class UserFeedback(Contract):
    """Browser -> backend. Owner: P4. Logged for evaluation (P3)."""

    feedback_id: Id
    bookmark_id: Id
    action: FeedbackAction
    t_browser_ms: BrowserMs
    media_time_s: MediaS | None


# --------------------------------------------------------------------------------------------
# Status (owner: Person 5)
# --------------------------------------------------------------------------------------------


class SensorState(Contract):
    state: SensorStateName
    reasons: list[ShortText]
    since_backend_ms: BackendMs


class SensorStatus(Contract):
    """Backend -> browser and inference. Sent on change. Owner: P5."""

    eeg: SensorState
    gaze: SensorState
    mode: OperatingMode
    automatic_suggestions: bool
    automatic_reason: ShortText
    t_backend_ms: BackendMs


class SessionSnapshot(Contract):
    """Backend -> browser after a successful resume. Replaces any client-side session state."""

    config: SessionConfig
    bookmarks: list[ReviewBookmark]
    sensor_status: SensorStatus
    last_seq: Count
