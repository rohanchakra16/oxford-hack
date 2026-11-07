import pytest

from inference.lecture_fusion import FocusFusion


def calibrated():
    fusion = FocusFusion()
    for _ in range(8):
        assert fusion.combine(0.9, 0.0, "cal-1", 1000) is None
    assert fusion.baseline_eeg == pytest.approx(0.9)
    return fusion


def test_calibration_then_weighted_loss_needs_both_sources_at_default_threshold():
    fusion = calibrated()
    assert fusion.combine(0.05, 0.0, "cal-1", 1000) > 0.3
    assert fusion.combine(0.9, 1.0, "cal-1", 1000) > 0.3
    assert fusion.combine(0.05, 1.0, "cal-1", 1000) < 0.3
    snapshot = fusion.snapshot(0.7)
    assert snapshot["combinedLoss"] == pytest.approx(0.6 * (0.85 / 0.9) + 0.4)
    assert snapshot["threshold"] == 0.7


@pytest.mark.parametrize(
    "eeg,gaze,duration",
    [
        (None, 1, 1000),
        (0.1, None, 1000),
        (float("nan"), 1, 1000),
        (0.1, float("inf"), 1000),
        (-0.1, 1, 1000),
        (0.1, 1.1, 1000),
        (0.1, 1, 0),
        (0.1, 1, 2001),
    ],
)
def test_invalid_inputs_clear_current_loss_without_reusing_old_values(
    eeg, gaze, duration
):
    fusion = calibrated()
    fusion.combine(0.05, 1, "cal-1", 1000)
    assert fusion.combine(eeg, gaze, "cal-1", duration) is None
    assert fusion.combined_loss is None


def test_calibration_requires_continuous_focused_data_and_restarts_for_new_camera_calibration():
    fusion = FocusFusion()
    for _ in range(7):
        fusion.combine(0.9, 0, "cal-1", 1000)
    fusion.interrupt()
    assert fusion.collected_ms == 0
    fusion.combine(0.2, 1, "cal-1", 1000)
    assert fusion.collected_ms == 0 and fusion.baseline_eeg is None
    for _ in range(8):
        fusion.combine(0.9, 0, "cal-1", 1000)
    assert fusion.baseline_eeg is not None
    assert fusion.combine(0.9, 0, "cal-2", 1000) is None
    assert fusion.baseline_eeg is None and fusion.collected_ms == 1000
