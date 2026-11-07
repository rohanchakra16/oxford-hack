"""Interface between the hub (Person 5) and the experimental detector (Person 3).

The hub calls an InferenceAdapter from its single event loop: no locking is needed inside it.
The adapter works entirely in backend time. It never sees media time or the playback mapping;
it only learns *whether* playback is eligible via ``on_eligibility``.

Rules for implementations (see docs/INTEGRATION.md#person-3):
* On ``on_eligibility`` with ``eligible=False`` or a new ``segment_id``: clear pending decisions.
  Only use evidence whose start is >= ``eligible_since_backend_ms`` of the current epoch.
  Do NOT ask Person 1 to reset EEG filters: filter continuity is separate from eligibility.
* Emit each event once with a stable ``event_id``; re-emitting the same id is dropped as duplicate.
* Declare evaluated modes honestly. Unevaluated modes stay manual-only in live sessions.
* Scores stay per signal (``ContributingSignal``); never merge them into a "focus percentage".
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Protocol

from ..contracts.base import AutomaticMode, RunKind
from ..contracts.payloads import (
    DetectorInfo,
    EegFeatureWindow,
    GazeCalibration,
    GazeObservation,
    PlaybackEligibility,
    ReviewCandidate,
    SensorStatus,
)


@dataclass(frozen=True)
class MappedGazeObservation:
    """A browser gaze observation with its frame time converted to backend time by the hub."""

    observation: GazeObservation
    t_backend_frame_ms: float
    clock_uncertainty_ms: float


@dataclass(frozen=True)
class SessionContext:
    session_id: str
    video_id: str
    run_kind: RunKind
    eeg_enabled: bool
    gaze_enabled: bool


class InferenceAdapter(Protocol):
    @property
    def detector(self) -> DetectorInfo: ...

    @property
    def evaluated_modes(self) -> frozenset[AutomaticMode]:
        """Modes with held-out evaluation behind them (from the model bundle manifest)."""
        ...

    def on_eeg_window(self, window: EegFeatureWindow) -> None: ...
    def on_gaze(self, observations: Sequence[MappedGazeObservation]) -> None: ...
    def on_gaze_calibration(self, calibration: GazeCalibration) -> None: ...
    def on_eligibility(self, eligibility: PlaybackEligibility) -> None: ...
    def on_sensor_status(self, status: SensorStatus) -> None: ...
    def poll(self, now_backend_ms: float) -> list[ReviewCandidate]: ...
    def close(self) -> None: ...


InferenceFactory = Callable[[SessionContext], InferenceAdapter | None]
"""Called once per session. Return None when no detector is configured (manual-only)."""
