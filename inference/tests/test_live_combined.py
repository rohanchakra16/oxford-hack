import pytest
from oxford_hack.contracts.payloads import ReviewCandidate
from oxford_hack.inference.interface import SessionContext

from inference.demo import setup, gaze_frame
from inference.live_attention import LiveAttentionConfig
from inference.live_combined import CombinedLiveAttention
from inference.tests.test_live_attention import window


def adapter():
    base = setup("both")
    result = CombinedLiveAttention(
        SessionContext("live-session", "synthetic-video", "live", True, True),
        LiveAttentionConfig(
            smoothing_ms=0, dwell_ms=1000, recovery_ms=500, boundary_margin_ms=0
        ),
    )
    result.on_eligibility(base._eligibility)
    result.on_sensor_status(base._sensors)
    cal = base._calibration.model_copy(
        update={
            "provenance": base._calibration.provenance.model_copy(
                update={"run_kind": "live"}
            )
        }
    )
    result.on_gaze_calibration(cal)
    return result, cal


def feed(result, start, stop, score=5, outside=True, valid=True):
    events = []
    for end in range(start, stop + 1, 500):
        # Controlled mapped-time fixtures, not hardware measurements.
        result.on_gaze(
            [
                gaze_frame(float(t), outside=outside, valid=valid)
                for t in range(max(0, end - 2000), end + 1, 100)
            ]
        )
        result.on_eeg_window(window(end, score))
        events.extend(result.poll(end + 150))
    return events


def test_live_combined_emits_both_signals_through_the_existing_contract():
    result, _ = adapter()
    assert feed(result, 2000, 2500) == []
    event = feed(result, 3000, 3000)[0]
    checked = ReviewCandidate.model_validate(event.model_dump(by_alias=False))
    assert checked.mode == "both"
    assert {s.signal for s in checked.contributing_signals} == {"eeg", "gaze"}
    assert checked.provenance.run_kind == "live"
    assert result.evaluated_modes == frozenset()


@pytest.mark.parametrize("score,outside", [(5, False), (90, True)])
def test_either_signal_alone_cannot_cross_combined_threshold(score, outside):
    result, _ = adapter()
    assert feed(result, 2000, 20000, score=score, outside=outside) == []


def test_invalid_or_expired_gaze_is_unknown_and_never_falls_back_after_opt_in():
    result, cal = adapter()
    assert feed(result, 2000, 5000, valid=False) == []
    assert result.status.state == "unknown"
    result.on_gaze_calibration(
        cal.model_copy(update={"status": "expired", "t_browser_ms": 6000.0})
    )
    assert feed(result, 6000, 15000) == []
    assert result.status.state == "unknown"


def test_gaze_gap_resets_dwell_and_cooldown_survives_recalibration():
    result, cal = adapter()
    first = feed(result, 2000, 3000)[0]
    feed(result, 3500, 4500, score=90, outside=False)
    result.on_gaze_calibration(cal.model_copy(update={"t_browser_ms": 5000.0}))
    assert feed(result, 5000, 32500) == []
    second = feed(result, 33000, 33000)[0]
    assert second.decision_backend_ms - first.decision_backend_ms == 30000


def test_missing_camera_calibration_preserves_existing_eeg_only_mode():
    base = setup("eeg_only")
    result = CombinedLiveAttention(
        SessionContext("live-session", "synthetic-video", "live", True, False),
        LiveAttentionConfig(smoothing_ms=0, dwell_ms=1000, boundary_margin_ms=0),
    )
    result.on_eligibility(base._eligibility)
    result.on_sensor_status(base._sensors)
    assert feed(result, 2000, 3000)[0].mode == "eeg_only"
