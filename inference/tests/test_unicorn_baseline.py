import importlib.util
import time

import pytest
from oxford_hack.contracts.payloads import EegFeatureWindow, EegStatus
from oxford_hack.eeg.interface import ThreadSafeEegSink
from oxford_hack.timing.clock import MonotonicClock

from inference.demo import eeg_window
from inference.tests.test_live_attention import adapter
from inference.unicorn_baseline import (
    BANDS,
    FEATURE_SET,
    PRODUCER,
    UnicornBaselineInference,
    spectral_values,
)
from inference.unicorn_source import UnicornSource

np = pytest.importorskip("numpy")


def raw_window(end, values):
    data = eeg_window().model_dump(by_alias=False)
    data.update(
        window_id=f"raw-{end}",
        feature_set_version=FEATURE_SET,
        evidence={"start_backend_ms": end - 2000, "end_backend_ms": end},
        t_processed_backend_ms=end + 150,
        features=[
            {
                "name": f"log_relative_{band}",
                "unit": "log_relative_power",
                "channel": c,
                "value": float(values[j]),
                "missing_reason": None,
            }
            for c in data["channels"]
            for j, (band, _, _) in enumerate(BANDS)
        ],
        provenance={
            "run_kind": "live",
            "producer": PRODUCER,
            "producer_version": "test",
        },
    )
    return EegFeatureWindow.model_validate(data)


def test_real_spectral_transform_preserves_channel_order_and_rejects_flatline():
    pytest.importorskip("scipy")
    t = np.arange(500) / 250
    values = spectral_values(
        np.stack([np.sin(2 * np.pi * 10 * t), np.sin(2 * np.pi * 20 * t)], axis=1), 250
    )
    assert np.argmax(values, axis=1).tolist() == [1, 2]
    with pytest.raises(ValueError, match="spectral power"):
        spectral_values(np.zeros((500, 2)), 250)


def test_baseline_calibrates_only_on_eight_seconds_then_reports_sustained_change():
    original = adapter()
    result = UnicornBaselineInference(original.context)
    result.on_eligibility(original._eligibility)
    result.on_sensor_status(original._sensors)
    for end in range(2500, 10500, 500):
        result.on_eeg_window(raw_window(end, [-2, -0.2, -3]))
        assert not result.poll(end + 150)
        assert result.baseline.mean is None
    result.on_eeg_window(raw_window(10500, [-2, -0.2, -3]))
    assert not result.poll(10650)
    assert result.baseline.mean is not None
    events = []
    for end in range(11000, 40000, 500):
        result.on_eeg_window(raw_window(end, [-0.1, -3, -3]))
        events.extend(result.poll(end + 150))
    assert len(events) == 1
    assert events[0].contributing_signals[0].scores[0].name == "baseline_similarity"
    assert result.evaluated_modes == frozenset()


def test_missing_vendor_sdk_reports_unavailable_and_never_uses_a_mock():
    if importlib.util.find_spec("UnicornPy"):
        pytest.skip("vendor SDK installed; do not open physical hardware during tests")
    sink = ThreadSafeEegSink()
    source = UnicornSource()
    source.start(sink, MonotonicClock())
    messages = []
    try:
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            messages.extend(sink.drain())
            if any(
                isinstance(m, EegStatus) and m.state == "unavailable" for m in messages
            ):
                break
            source.stop_event.wait(0.01)
    finally:
        source.stop()
    assert any(isinstance(m, EegStatus) and m.state == "unavailable" for m in messages)
    assert not any(isinstance(m, EegFeatureWindow) for m in messages)
