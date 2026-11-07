"""Message envelopes, the message registry, and strict wire parsing.

This module and ``payloads.py`` are the single source of truth for the shared contract.
``contracts/schema/oxford-hack.schema.json`` and the frontend TypeScript types are generated
from here by ``npm run contracts:generate``; never edit the generated files by hand.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Annotated, Any, Literal

from pydantic import Field, TypeAdapter, ValidationError

from . import payloads as p
from .base import SCHEMA_VERSION, Contract, Count, Id, SchemaVersion

MAX_MESSAGE_BYTES = 256 * 1024


class EnvelopeBase(Contract):
    """Common envelope. ``seq`` is per sender and per session (browser) or per session (backend);
    receivers use it for ordering and gap detection. ``sessionId`` is null only before a session exists.
    """

    schema_version: SchemaVersion
    message_id: Id
    session_id: Id | None
    seq: Count


# One envelope class per message type keeps the generated schema and TS types explicit.
class ClientHelloMessage(EnvelopeBase):
    type: Literal["client_hello"]
    payload: p.ClientHello


class ServerHelloMessage(EnvelopeBase):
    type: Literal["server_hello"]
    payload: p.ServerHello


class HeartbeatMessage(EnvelopeBase):
    type: Literal["heartbeat"]
    payload: p.Heartbeat


class ClockPingMessage(EnvelopeBase):
    type: Literal["clock_ping"]
    payload: p.ClockPing


class ClockPongMessage(EnvelopeBase):
    type: Literal["clock_pong"]
    payload: p.ClockPong


class ClockStatusMessage(EnvelopeBase):
    type: Literal["clock_status"]
    payload: p.ClockStatus


class SessionStartMessage(EnvelopeBase):
    type: Literal["session_start"]
    payload: p.SessionStart


class SessionEndMessage(EnvelopeBase):
    type: Literal["session_end"]
    payload: p.SessionEnd


class SessionConfigMessage(EnvelopeBase):
    type: Literal["session_config"]
    payload: p.SessionConfig


class SessionEndedMessage(EnvelopeBase):
    type: Literal["session_ended"]
    payload: p.SessionEnded


class SessionSnapshotMessage(EnvelopeBase):
    type: Literal["session_snapshot"]
    payload: p.SessionSnapshot


class ErrorMessage(EnvelopeBase):
    type: Literal["error"]
    payload: p.ErrorReport


class PlaybackStateMessage(EnvelopeBase):
    type: Literal["playback_state"]
    payload: p.PlaybackState


class PlaybackEligibilityMessage(EnvelopeBase):
    type: Literal["playback_eligibility"]
    payload: p.PlaybackEligibility


class EegFeatureWindowMessage(EnvelopeBase):
    type: Literal["eeg_features"]
    payload: p.EegFeatureWindow


class EegStatusMessage(EnvelopeBase):
    type: Literal["eeg_status"]
    payload: p.EegStatus


class GazeObservationBatchMessage(EnvelopeBase):
    type: Literal["gaze_observations"]
    payload: p.GazeObservationBatch


class GazeCalibrationMessage(EnvelopeBase):
    type: Literal["gaze_calibration"]
    payload: p.GazeCalibration


class ReviewCandidateMessage(EnvelopeBase):
    type: Literal["review_candidate"]
    payload: p.ReviewCandidate


class ReviewBookmarkMessage(EnvelopeBase):
    type: Literal["review_bookmark"]
    payload: p.ReviewBookmark


class ManualBookmarkMessage(EnvelopeBase):
    type: Literal["manual_bookmark"]
    payload: p.ManualBookmark


class CandidateRejectedMessage(EnvelopeBase):
    type: Literal["candidate_rejected"]
    payload: p.CandidateRejected


class UserFeedbackMessage(EnvelopeBase):
    type: Literal["user_feedback"]
    payload: p.UserFeedback


class SensorStatusMessage(EnvelopeBase):
    type: Literal["sensor_status"]
    payload: p.SensorStatus


Channel = Literal["browser_to_backend", "backend_to_browser", "backend_internal", "both_ws"]


@dataclass(frozen=True)
class MessageSpec:
    model: type[EnvelopeBase]
    channel: Channel
    sender: str
    receiver: str
    owner: str


MESSAGES: dict[str, MessageSpec] = {
    "client_hello": MessageSpec(ClientHelloMessage, "browser_to_backend", "browser", "backend", "P5"),
    "server_hello": MessageSpec(ServerHelloMessage, "backend_to_browser", "backend", "browser", "P5"),
    "heartbeat": MessageSpec(HeartbeatMessage, "both_ws", "browser|backend", "backend|browser", "P5"),
    "clock_ping": MessageSpec(ClockPingMessage, "backend_to_browser", "backend", "browser", "P5"),
    "clock_pong": MessageSpec(ClockPongMessage, "browser_to_backend", "browser", "backend", "P5"),
    "clock_status": MessageSpec(ClockStatusMessage, "backend_to_browser", "backend", "browser", "P5"),
    "session_start": MessageSpec(SessionStartMessage, "browser_to_backend", "browser (P4)", "backend", "P5"),
    "session_end": MessageSpec(SessionEndMessage, "browser_to_backend", "browser (P4)", "backend", "P5"),
    "session_config": MessageSpec(SessionConfigMessage, "backend_to_browser", "backend", "browser", "P5"),
    "session_ended": MessageSpec(SessionEndedMessage, "backend_to_browser", "backend", "browser", "P5"),
    "session_snapshot": MessageSpec(SessionSnapshotMessage, "backend_to_browser", "backend", "browser", "P5"),
    "error": MessageSpec(ErrorMessage, "both_ws", "browser|backend", "backend|browser", "P5"),
    "playback_state": MessageSpec(PlaybackStateMessage, "browser_to_backend", "browser (P4)", "backend", "P4"),
    "playback_eligibility": MessageSpec(
        PlaybackEligibilityMessage, "backend_to_browser", "backend", "inference (P3), browser", "P5"
    ),
    "eeg_features": MessageSpec(EegFeatureWindowMessage, "backend_internal", "EEG (P1)", "hub, inference", "P1"),
    "eeg_status": MessageSpec(EegStatusMessage, "backend_internal", "EEG (P1)", "hub", "P1"),
    "gaze_observations": MessageSpec(
        GazeObservationBatchMessage, "browser_to_backend", "browser (P2)", "backend", "P2"
    ),
    "gaze_calibration": MessageSpec(GazeCalibrationMessage, "browser_to_backend", "browser (P2)", "backend", "P2"),
    "review_candidate": MessageSpec(ReviewCandidateMessage, "backend_internal", "inference (P3)", "hub", "P3"),
    "review_bookmark": MessageSpec(ReviewBookmarkMessage, "backend_to_browser", "backend", "browser (P4)", "P5"),
    "manual_bookmark": MessageSpec(ManualBookmarkMessage, "browser_to_backend", "browser (P4)", "backend", "P4"),
    "candidate_rejected": MessageSpec(
        CandidateRejectedMessage, "backend_to_browser", "backend", "browser (diagnostics)", "P5"
    ),
    "user_feedback": MessageSpec(UserFeedbackMessage, "browser_to_backend", "browser (P4)", "backend", "P4"),
    "sensor_status": MessageSpec(SensorStatusMessage, "backend_to_browser", "backend", "browser, inference", "P5"),
}

BROWSER_TO_BACKEND = frozenset(k for k, v in MESSAGES.items() if v.channel in ("browser_to_backend", "both_ws"))
BACKEND_INTERNAL = frozenset(k for k, v in MESSAGES.items() if v.channel == "backend_internal")

AnyMessage = Annotated[
    ClientHelloMessage
    | ServerHelloMessage
    | HeartbeatMessage
    | ClockPingMessage
    | ClockPongMessage
    | ClockStatusMessage
    | SessionStartMessage
    | SessionEndMessage
    | SessionConfigMessage
    | SessionEndedMessage
    | SessionSnapshotMessage
    | ErrorMessage
    | PlaybackStateMessage
    | PlaybackEligibilityMessage
    | EegFeatureWindowMessage
    | EegStatusMessage
    | GazeObservationBatchMessage
    | GazeCalibrationMessage
    | ReviewCandidateMessage
    | ReviewBookmarkMessage
    | ManualBookmarkMessage
    | CandidateRejectedMessage
    | UserFeedbackMessage
    | SensorStatusMessage,
    Field(discriminator="type"),
]
ANY_MESSAGE_ADAPTER: TypeAdapter[AnyMessage] = TypeAdapter(AnyMessage)


class ContractError(Exception):
    """A message was rejected. ``code`` is an ErrorCode; ``message`` is safe to show and log
    (it never includes field values, so signal data cannot leak into logs)."""

    def __init__(self, code: p.ErrorCode, message: str, *, message_id: str | None = None) -> None:
        super().__init__(message)
        self.code: p.ErrorCode = code
        self.message = message
        self.message_id = message_id


def _reject_constant(name: str) -> Any:
    raise ContractError("invalid_json", f"non-finite number {name} is not allowed")


def _no_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            raise ContractError("invalid_json", f"duplicate key {key!r}")
        out[key] = value
    return out


def _summarise(err: ValidationError, limit: int = 4) -> str:
    parts = []
    for e in err.errors(include_input=False, include_url=False)[:limit]:
        path = list(e["loc"])
        if path and path[0] in MESSAGES:  # drop the discriminator tag
            path = path[1:]
        loc = ".".join(str(x) for x in path)
        parts.append(f"{loc or '<root>'}: {e['msg']}")
    more = err.error_count() - limit
    return "; ".join(parts) + (f"; and {more} more" if more > 0 else "")


def parse_message(raw: str | bytes, *, allowed_types: frozenset[str] | None = None) -> AnyMessage:
    """Parse and validate one wire message. Raises ContractError with a readable reason."""
    if len(raw) > MAX_MESSAGE_BYTES:
        raise ContractError("message_too_large", f"message exceeds {MAX_MESSAGE_BYTES} bytes")
    try:
        obj = json.loads(raw, parse_constant=_reject_constant, object_pairs_hook=_no_duplicate_keys)
    except ContractError:
        raise
    except (ValueError, UnicodeDecodeError) as exc:
        raise ContractError("invalid_json", f"not valid JSON: {exc.__class__.__name__}") from None
    return validate_message(obj, allowed_types=allowed_types)


def validate_message(obj: object, *, allowed_types: frozenset[str] | None = None) -> AnyMessage:
    """Validate an already-decoded JSON value (wire names only)."""
    if not isinstance(obj, dict):
        raise ContractError("invalid_message", "message must be a JSON object")
    message_id = obj.get("messageId") if isinstance(obj.get("messageId"), str) else None
    version = obj.get("schemaVersion")
    if version != SCHEMA_VERSION:
        raise ContractError(
            "schema_version_mismatch",
            f"received schemaVersion {version!r}; this component supports exactly {SCHEMA_VERSION!r}",
            message_id=message_id,
        )
    msg_type = obj.get("type")
    if not isinstance(msg_type, str) or msg_type not in MESSAGES:
        raise ContractError("unknown_type", f"unknown message type {msg_type!r}", message_id=message_id)
    if allowed_types is not None and msg_type not in allowed_types:
        raise ContractError("unexpected_type", f"{msg_type!r} is not accepted here", message_id=message_id)
    try:
        return ANY_MESSAGE_ADAPTER.validate_python(obj, by_alias=True, by_name=False)
    except ValidationError as err:
        raise ContractError("invalid_message", f"{msg_type}: {_summarise(err)}", message_id=message_id) from None


def to_wire(message: EnvelopeBase) -> dict[str, Any]:
    return message.model_dump(mode="json", by_alias=True)


def dumps(message: EnvelopeBase) -> str:
    return json.dumps(to_wire(message), separators=(",", ":"), allow_nan=False)


def envelope(
    msg_type: str, payload: Contract, *, message_id: str, session_id: str | None, seq: int
) -> AnyMessage:
    """Build a validated envelope for ``payload``."""
    spec = MESSAGES[msg_type]
    return spec.model.model_validate(  # type: ignore[return-value]
        {
            "schema_version": SCHEMA_VERSION,
            "type": msg_type,
            "message_id": message_id,
            "session_id": session_id,
            "seq": seq,
            "payload": payload,
        },
        by_name=True,
    )
