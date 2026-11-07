from dataclasses import replace

import pytest
from oxford_hack.contracts.payloads import EegFeatureWindow, PlaybackEligibility
from oxford_hack.inference.interface import SessionContext

from inference.demo import eeg_window, setup
from inference.live_attention import (
    LiveAttentionConfig,
    LiveAttentionInference,
    inference_factory,
)


def adapter(**config):
    config.setdefault("boundary_margin_ms", 0)
    original = setup("eeg_only")
    result = LiveAttentionInference(
        SessionContext("live-session", "synthetic-video", "live", True, False),
        LiveAttentionConfig(**config),
    )
    result.on_eligibility(original._eligibility)
    result.on_sensor_status(original._sensors)
    return result


def window(end, value=5.0, **changes):
    # Controlled model outputs only: these tests never claim physical EEG evidence.
    values = eeg_window().model_dump(by_alias=False)
    values.update(
        window_id=f"controlled-model-{end}",
        t_processed_backend_ms=end + 150,
        samples={"expected": 500, "received": 500},
        feature_set_version="lecture-attention-0.1.0",
        evidence={"start_backend_ms": end - 2000, "end_backend_ms": end},
        provenance={
            "run_kind": "live",
            "producer": "lecture-attention-model",
            "producer_version": "test",
        },
        features=[
            {
                "name": "attention_score",
                "unit": "score_0_100",
                "channel": None,
                "value": value,
                "missing_reason": None,
            }
        ],
    )
    values.update(changes)
    return EegFeatureWindow.model_validate(values)


def feed(result, start, stop, value=5.0):
    events = []
    for end in range(start, stop + 1, 500):
        result.on_eeg_window(window(end, value))
        events.extend(result.poll(end + 150))
    return events


def test_live_score_requires_full_eight_second_dwell_then_emits_once_per_loss():
    result = adapter()
    assert feed(result, 2000, 9500) == []
    events = feed(result, 10000, 10000)
    assert len(events) == 1
    event = events[0]
    assert (event.evidence.start_backend_ms, event.evidence.end_backend_ms) == (
        0,
        10000,
    )
    assert event.provenance.run_kind == "live"
    assert event.mode == "eeg_only"
    assert len(event.contributing_signals[0].window_ids) == 17
    assert feed(result, 10500, 60000) == []
    assert result.evaluated_modes == frozenset()


def test_recovery_rearms_separate_episode_and_thirty_second_cooldown_is_enforced():
    result = adapter(smoothing_ms=0, dwell_ms=1000, recovery_ms=500)
    first = feed(result, 2000, 3000)[0]
    assert feed(result, 3500, 4500, value=90) == []
    assert feed(result, 5000, 32500) == []
    second = feed(result, 33000, 33000)[0]
    assert second.decision_backend_ms - first.decision_backend_ms == 30000
    assert first.event_id != second.event_id


@pytest.mark.parametrize(
    "changes",
    [
        {"feature_set_version": "eegmat-workload-0.1.0"},
        {
            "provenance": {
                "run_kind": "simulated",
                "producer": "lecture-attention-model",
                "producer_version": "test",
            }
        },
        {
            "provenance": {
                "run_kind": "live",
                "producer": "stub",
                "producer_version": "test",
            }
        },
        {"samples": {"expected": 1000, "received": 999}},
        {
            "clock_correction": {
                "method": "same_clock",
                "offset_s": 0,
                "drift_ppm": None,
                "uncertainty_ms": None,
            }
        },
    ],
)
def test_invalid_or_nonattention_source_is_unknown_and_never_a_reminder(changes):
    result = adapter()
    for end in range(2000, 15000, 500):
        result.on_eeg_window(window(end, **changes))
        assert result.poll(end + 150) == []
        assert result.status.state == "unknown"


def test_polling_does_not_accumulate_dwell_and_stale_data_clears_pending():
    result = adapter()
    result.on_eeg_window(window(2000))
    for now in range(2150, 4000, 100):
        assert result.poll(now) == []
    assert result.poll(4500) == []
    assert result.status.state == "unknown"
    assert feed(result, 5000, 12500) == []
    assert len(feed(result, 13000, 13000)) == 1


def test_pausing_and_seeking_require_new_complete_in_epoch_evidence():
    result = adapter()
    assert feed(result, 2000, 9000) == []
    result.on_eligibility(
        PlaybackEligibility(
            video_id="synthetic-video",
            segment_id=None,
            eligible=False,
            reason="paused",
            epoch=2,
            eligible_since_backend_ms=None,
            t_backend_ms=9200,
        )
    )
    assert result.poll(9500) == []
    result.on_eligibility(
        PlaybackEligibility(
            video_id="synthetic-video",
            segment_id="resumed",
            eligible=True,
            reason="playing",
            epoch=3,
            eligible_since_backend_ms=10000,
            t_backend_ms=10000,
        )
    )
    assert feed(result, 10000, 11500) == []
    assert result.status.state == "unknown"
    assert feed(result, 12000, 19500) == []
    assert len(feed(result, 20000, 20000)) == 1


def test_factory_does_not_create_live_adapter_for_simulation_or_disabled_eeg():
    context = SessionContext("session", "video", "live", True, False)
    assert inference_factory(context) is not None
    assert inference_factory(replace(context, run_kind="simulated")) is None
    assert inference_factory(replace(context, eeg_enabled=False)) is None
