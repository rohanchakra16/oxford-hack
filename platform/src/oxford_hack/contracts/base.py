"""Shared building blocks for every contract model.

Conventions (see contracts/README.md):

* Wire names are camelCase; Python attributes are snake_case.
* Every time field names its clock and unit:
    - ``...BrowserMs``  browser ``performance.now()`` milliseconds (origin: page load; per browser tab).
    - ``...BackendMs``  backend monotonic milliseconds (origin: arbitrary; per backend process,
                        identified by ``backendInstanceId``).
    - ``...DeviceS``    acquisition-device / LSL clock seconds (origin: device-specific).
    - ``...MediaS``     media (video playback position) seconds.
  No two clocks are assumed to share an origin.
* Missing measurements are ``null`` with a reason, never ``0``.
* Unknown fields are rejected; NaN/Infinity are rejected.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

SCHEMA_VERSION = "0.2.0"
"""Exact-match version. Receivers reject any other value (see contracts/README.md#compatibility)."""

SchemaVersion = Literal["0.2.0"]


class Contract(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        validate_by_name=True,
        validate_by_alias=True,
        serialize_by_alias=True,
        extra="forbid",
        frozen=True,
        allow_inf_nan=False,
        strict=True,
    )


Id = Annotated[
    str,
    Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$"),
]
"""Opaque identifier. Compare for equality only; never parse."""

BrowserMs = Annotated[float, Field(ge=0, description="Browser performance.now() milliseconds.")]
BackendMs = Annotated[float, Field(ge=0, description="Backend monotonic milliseconds.")]
DeviceS = Annotated[float, Field(description="Acquisition-device / LSL clock seconds.")]
MediaS = Annotated[float, Field(ge=0, description="Media playback position in seconds.")]
DurationMs = Annotated[float, Field(ge=0, description="Duration in milliseconds.")]
Count = Annotated[int, Field(ge=0)]
Label = Annotated[str, Field(min_length=1, max_length=200)]
ShortText = Annotated[str, Field(max_length=500)]

RunKind = Literal["live", "replay", "simulated"]
"""How the data in a session was produced. Shown on every bookmark; replay/simulated are never 'live'."""

OperatingMode = Literal["both", "eeg_only", "gaze_only", "manual_only"]
AutomaticMode = Literal["both", "eeg_only", "gaze_only"]


class BackendInterval(Contract):
    """Closed interval on the backend clock. ``end >= start``."""

    start_backend_ms: BackendMs
    end_backend_ms: BackendMs

    @model_validator(mode="after")
    def _ordered(self) -> BackendInterval:
        if self.end_backend_ms < self.start_backend_ms:
            raise ValueError("endBackendMs must be >= startBackendMs")
        return self


class MediaInterval(Contract):
    """Closed interval in media seconds. ``end >= start``."""

    start_media_s: MediaS
    end_media_s: MediaS

    @model_validator(mode="after")
    def _ordered(self) -> MediaInterval:
        if self.end_media_s < self.start_media_s:
            raise ValueError("endMediaS must be >= startMediaS")
        return self


class Provenance(Contract):
    """Who produced a message and in what kind of run."""

    run_kind: RunKind
    producer: Label = Field(description="Component name, e.g. 'synthetic-eeg' or 'unicorn-lsl-adapter'.")
    producer_version: Label
