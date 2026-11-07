"""Reproducible SYNTHETIC inputs and candidate/status fixtures, not performance evidence."""

import argparse
import json

from oxford_hack.contracts.payloads import (
    CssRect,
    GazeCalibration,
    GazeObservation,
    NormalisedPoint,
    PlaybackEligibility,
    SensorState,
    SensorStatus,
)
from oxford_hack.harness.synthetic import SyntheticEegProducer
from oxford_hack.inference.interface import MappedGazeObservation, SessionContext

from .adapter import BaselineInference


def setup(mode="both") -> BaselineInference:
    adapter = BaselineInference(
        SessionContext(
            "synthetic-session", "synthetic-video", "simulated", mode != "gaze_only", mode != "eeg_only"
        )
    )
    adapter.on_eligibility(
        PlaybackEligibility(
            video_id="synthetic-video",
            segment_id="synthetic-segment",
            eligible=True,
            reason="playing",
            epoch=1,
            eligible_since_backend_ms=0.0,
            t_backend_ms=0.0,
        )
    )
    adapter.on_sensor_status(
        SensorStatus(
            eeg=SensorState(
                state="ok" if mode != "gaze_only" else "disabled", reasons=[], since_backend_ms=0.0
            ),
            gaze=SensorState(
                state="ok" if mode != "eeg_only" else "disabled", reasons=[], since_backend_ms=0.0
            ),
            mode=mode,
            automatic_suggestions=True,
            automatic_reason="SYNTHETIC test",
            t_backend_ms=0.0,
        )
    )
    adapter.on_gaze_calibration(
        GazeCalibration(
            calibration_id="synthetic-calibration",
            status="valid",
            measurement_kind="screen_gaze",
            method="scripted SYNTHETIC",
            fit_points=9,
            held_out_points=4,
            held_out_error_norm=0.05,
            viewport_css_px=CssRect(x=0.0, y=0.0, width=1000.0, height=800.0),
            video_rect_css_px=CssRect(x=0.0, y=0.0, width=1000.0, height=800.0),
            invalidated_reason=None,
            t_browser_ms=0.0,
            provenance={"run_kind": "simulated", "producer": "synthetic-gaze", "producer_version": "0.1.0"},
        )
    )
    return adapter


def eeg_window(end=4000.0, value=0.9, usable=True):
    producer = SyntheticEegProducer()
    producer.poll(0.0)
    from oxford_hack.contracts.payloads import EegFeatureWindow

    window = next(w for w in producer.poll(4150.0) if isinstance(w, EegFeatureWindow))
    data = window.model_dump(by_alias=False)
    data.update(
        window_id=f"synthetic-eeg-{int(end)}",
        evidence={"start_backend_ms": end - 4000.0, "end_backend_ms": end},
        t_processed_backend_ms=end + 150.0,
    )
    data["features"][0]["value"] = value
    data["quality"]["usable"] = usable
    return EegFeatureWindow.model_validate(data)


def gaze_frame(time_ms, *, outside=True, valid=True, kind="screen_gaze"):
    return MappedGazeObservation(
        GazeObservation(
            observation_id=f"synthetic-gaze-{int(time_ms)}",
            t_browser_frame_ms=time_ms,
            t_browser_processed_ms=time_ms + 10.0,
            measurement_kind=kind,
            calibration_id="synthetic-calibration",
            valid=valid,
            invalid_reasons=[] if valid else ["face_not_detected"],
            video_point=NormalisedPoint(x=1.5 if outside else 0.5, y=0.5) if valid else None,
            inside_video=not outside if valid else None,
            model_confidence=0.9 if valid else None,
        ),
        t_backend_frame_ms=time_ms,
        clock_uncertainty_ms=1.0,
    )


def run_demo(mode="both") -> dict:
    adapter = setup(mode)
    candidates, statuses = [], []
    for t in range(0, 7001, 250):
        adapter.on_gaze([gaze_frame(float(t))])
        if t >= 4000 and t % 1000 == 0:
            adapter.on_eeg_window(eeg_window(float(t)))
        candidates.extend(c.model_dump(mode="json", by_alias=True) for c in adapter.poll(t + 150.0))
        statuses.append(
            {"tBackendMs": t + 150.0, "state": adapter.status.state, "reason": adapter.status.reason}
        )
    adapter.on_eligibility(
        PlaybackEligibility(
            video_id="synthetic-video",
            segment_id=None,
            eligible=False,
            reason="paused",
            epoch=2,
            eligible_since_backend_ms=None,
            t_backend_ms=7250.0,
        )
    )
    adapter.poll(7250.0)
    statuses.append({"tBackendMs": 7250.0, "state": adapter.status.state, "reason": adapter.status.reason})
    return {"synthetic": True, "mode": mode, "candidates": candidates, "statuses": statuses}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["both", "eeg_only", "gaze_only"], default="both")
    args = parser.parse_args()
    print(json.dumps(run_demo(args.mode), indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
