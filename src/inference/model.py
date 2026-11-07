"""Versioned, strictly validated baseline configuration. No trained weights."""

from pathlib import Path
from typing import Literal

from oxford_hack.contracts.base import Contract, Id, Label
from oxford_hack.contracts.payloads import DetectorInfo
from pydantic import Field, model_validator

DEFAULT_BUNDLE = Path(__file__).parent / "bundles" / "baseline-0.1.0.json"


class ModelBundle(Contract):
    detector_id: Id
    detector_version: Label
    config_version: Label
    synthetic_only: Literal[True]
    # Deliberately impossible to declare evaluated modes without a future evidence-backed change.
    evaluated_modes: list[Literal["both", "eeg_only", "gaze_only"]] = Field(max_length=0)
    evidence_ms: float = Field(gt=0)
    dwell_ms: float = Field(ge=0)
    cooldown_ms: float = Field(ge=0)
    max_step_ms: float = Field(gt=0)
    max_age_ms: float = Field(gt=0)
    max_clock_uncertainty_ms: float = Field(ge=0)
    gaze_max_gap_ms: float = Field(gt=0)
    gaze_min_valid_fraction: float = Field(gt=0, le=1)
    gaze_outside_threshold: float = Field(ge=0, le=1)
    eeg_feature_set_version: Label
    eeg_feature_name: Label
    eeg_feature_unit: Label
    eeg_feature_channel: Label | None
    eeg_threshold: float

    @model_validator(mode="after")
    def bounded_gaze_window(self) -> "ModelBundle":
        if self.gaze_max_gap_ms > self.evidence_ms:
            raise ValueError("gaze gap must not exceed evidence duration")
        return self

    @property
    def detector(self) -> DetectorInfo:
        return DetectorInfo(
            detector_id=self.detector_id,
            detector_version=self.detector_version,
            config_version=self.config_version,
        )


def load_bundle(path: str | Path = DEFAULT_BUNDLE) -> ModelBundle:
    return ModelBundle.model_validate_json(Path(path).read_text(encoding="utf-8"))
