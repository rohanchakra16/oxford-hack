from dataclasses import replace

import pytest
from oxford_hack.contracts.payloads import PlaybackEligibility, ReviewCandidate
from oxford_hack.inference.interface import SessionContext
from pydantic import ValidationError

from inference.adapter import BaselineInference, inference_factory
from inference.demo import eeg_window, gaze_frame, run_demo, setup
from inference.model import load_bundle


@pytest.mark.parametrize("mode", ["both", "eeg_only", "gaze_only"])
def test_modes_and_contract_round_trip(mode):
    result = run_demo(mode)
    assert len(result["candidates"]) == 1
    candidate = ReviewCandidate.model_validate(result["candidates"][0])
    assert candidate.mode == mode
    assert candidate.evidence.start_backend_ms == 0.0
    assert candidate.evidence.end_backend_ms == 6000.0
    if mode in ("both", "eeg_only"):
        assert len(candidate.contributing_signals[0].window_ids) == 3
    assert candidate.provenance.run_kind == "simulated"
    assert result["statuses"][-1]["state"] == "interrupted"
    assert setup(mode).evaluated_modes == frozenset()


def test_repeated_polling_never_accumulates_dwell():
    adapter = setup("eeg_only")
    adapter.on_eeg_window(eeg_window())
    for t in range(4150, 5500, 100):
        assert adapter.poll(float(t)) == []
    assert adapter.poll(7000.0) == []
    assert adapter.status.state == "unknown"


def test_bad_quality_breaks_dwell():
    adapter = setup("eeg_only")
    for end, usable in [(4000.0, True), (5000.0, False), (6000.0, True), (7000.0, True)]:
        adapter.on_eeg_window(eeg_window(end, usable=usable))
        assert adapter.poll(end + 150.0) == []
    adapter.on_eeg_window(eeg_window(8000.0))
    assert len(adapter.poll(8150.0)) == 1
    assert adapter.poll(8150.0) == []


def test_epoch_reset_rejects_cross_boundary_evidence():
    adapter = setup("eeg_only")
    adapter.on_eeg_window(eeg_window())
    adapter.poll(4150.0)
    adapter.on_eligibility(
        PlaybackEligibility(
            video_id="synthetic-video",
            segment_id="resumed",
            eligible=True,
            reason="playing",
            epoch=2,
            eligible_since_backend_ms=4500.0,
            t_backend_ms=4500.0,
        )
    )
    adapter.on_eeg_window(eeg_window(6000.0))
    assert adapter.poll(6150.0) == []
    assert adapter.status.state == "unknown"


@pytest.mark.parametrize(
    "change",
    [
        {"feature_set_version": "other"},
        {
            "clock_correction": {
                "method": "same_clock",
                "offset_s": 0.0,
                "drift_ppm": None,
                "uncertainty_ms": None,
            }
        },
        {"samples": {"expected": 500, "received": 490}},
        {"t_processed_backend_ms": 9000.0},
    ],
)
def test_eeg_contract_semantics_are_gated(change):
    adapter = setup("eeg_only")
    data = eeg_window().model_dump(by_alias=False)
    data.update(change)
    adapter.on_eeg_window(type(eeg_window()).model_validate(data))
    assert adapter.poll(4150.0) == []
    assert adapter.status.state == "unknown"


@pytest.mark.parametrize(
    "kind,valid,uncertainty",
    [
        ("head_direction", True, 1.0),
        ("screen_gaze", False, 1.0),
        ("screen_gaze", True, 100.0),
    ],
)
def test_invalid_gaze_is_unknown_not_a_review_event(kind, valid, uncertainty):
    adapter = setup("gaze_only")
    for t in range(0, 7001, 250):
        frame = replace(gaze_frame(float(t), kind=kind, valid=valid), clock_uncertainty_ms=uncertainty)
        adapter.on_gaze([frame])
        assert adapter.poll(t + 150.0) == []
    assert adapter.status.state == "unknown"


def test_gaze_gap_is_not_outside_video_evidence():
    adapter = setup("gaze_only")
    adapter.on_gaze([gaze_frame(0.0), gaze_frame(4000.0)])
    assert adapter.poll(4150.0) == []
    assert adapter.status.state == "unknown"


def test_combined_requires_both_thresholds():
    adapter = setup()
    for t in range(0, 7001, 250):
        adapter.on_gaze([gaze_frame(float(t), outside=False)])
        if t >= 4000 and t % 1000 == 0:
            adapter.on_eeg_window(eeg_window(float(t)))
        assert adapter.poll(t + 150.0) == []
    assert adapter.status.state == "ready"


def test_synthetic_bundle_cannot_enable_live():
    context = SessionContext("session", "video", "live", True, True)
    assert inference_factory(context) is None
    adapter = BaselineInference(context)
    assert not adapter.evaluated_modes


def test_invalid_bundle_rejected():
    data = load_bundle().model_dump(by_alias=False)
    data["evaluated_modes"] = ["both"]
    with pytest.raises(ValidationError):
        type(load_bundle()).model_validate(data)
    data["evaluated_modes"] = []
    data["evidence_ms"] = float("nan")
    with pytest.raises(ValidationError):
        type(load_bundle()).model_validate(data)


def test_close_stops_output():
    adapter = setup()
    adapter.close()
    assert adapter.poll(9000.0) == []
    assert adapter.status.state == "closed"


def test_cooldown_requires_new_dwell_after_expiry():
    adapter = setup("eeg_only")
    adapter.bundle = adapter.bundle.model_copy(update={"cooldown_ms": 3000.0})
    emitted = []
    for end in range(4000, 12001, 1000):
        adapter.on_eeg_window(eeg_window(float(end)))
        emitted.extend(adapter.poll(end + 150.0))
    assert [c.evidence.end_backend_ms for c in emitted] == [6000.0, 11000.0]
    assert len({c.event_id for c in emitted}) == 2


def test_bad_window_between_polls_resets_pending():
    adapter = setup("eeg_only")
    adapter.on_eeg_window(eeg_window())
    adapter.poll(4150.0)
    adapter.on_eeg_window(eeg_window(4500.0, usable=False))
    for end in (5000.0, 6000.0):
        adapter.on_eeg_window(eeg_window(end))
        assert adapter.poll(end + 150.0) == []
    adapter.on_eeg_window(eeg_window(7000.0))
    assert len(adapter.poll(7150.0)) == 1


def test_resume_waits_for_complete_fresh_evidence_and_dwell():
    adapter = setup("eeg_only")
    adapter.on_eeg_window(eeg_window())
    adapter.poll(4150.0)
    adapter.on_eligibility(
        PlaybackEligibility(
            video_id="synthetic-video",
            segment_id=None,
            eligible=False,
            reason="paused",
            epoch=2,
            eligible_since_backend_ms=None,
            t_backend_ms=4500.0,
        )
    )
    assert adapter.poll(4500.0) == []
    assert adapter.status.state == "interrupted"
    adapter.on_eligibility(
        PlaybackEligibility(
            video_id="synthetic-video",
            segment_id="resumed",
            eligible=True,
            reason="playing",
            epoch=3,
            eligible_since_backend_ms=5000.0,
            t_backend_ms=5000.0,
        )
    )
    for end in (8000.0, 9000.0, 10000.0):
        adapter.on_eeg_window(eeg_window(end))
        assert adapter.poll(end + 150.0) == []
    adapter.on_eeg_window(eeg_window(11000.0))
    candidate = adapter.poll(11150.0)[0]
    assert candidate.evidence.start_backend_ms == 5000.0
    assert candidate.eligibility_epoch == 3
