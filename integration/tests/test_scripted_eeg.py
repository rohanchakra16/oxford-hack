"""Scripted test EEG through the real live adapter: what a rehearsal user should see."""

from __future__ import annotations

import pytest
from inference.demo import setup
from inference.live_attention import LiveAttentionConfig, LiveAttentionInference

from integration.rehearsal.scripted_eeg import (
    DECLARED_DEVICE,
    DEFAULT_SCRIPT,
    ENV_FLAG,
    ScriptedSource,
    make_source,
    score_at,
)
from oxford_hack.inference.interface import SessionContext


def run_script(script=DEFAULT_SCRIPT, stop_ms=140_000):
    original = setup("eeg_only")
    adapter = LiveAttentionInference(
        SessionContext("rehearsal", "synthetic-video", "live", True, False),
        LiveAttentionConfig(boundary_margin_ms=0),
    )
    adapter.on_eligibility(original._eligibility)
    adapter.on_sensor_status(original._sensors)
    source = ScriptedSource(script)
    source._started_ms = 0.0
    events, states = [], []
    for end in range(2000, stop_ms, 500):
        adapter.on_eeg_window(source.window_ending(end))
        for event in adapter.poll(end + 150):
            events.append((end / 1000, event))
        states.append((end / 1000, adapter.status.state))
    return events, states


def test_refuses_to_start_without_the_explicit_rehearsal_flag(monkeypatch) -> None:
    monkeypatch.delenv(ENV_FLAG, raising=False)
    with pytest.raises(ValueError, match=ENV_FLAG):
        make_source()
    monkeypatch.setenv(ENV_FLAG, "1")
    assert isinstance(make_source(), ScriptedSource)


def test_declares_itself_as_not_a_headset() -> None:
    assert DECLARED_DEVICE.confirmed is False
    assert "not a headset" in (DECLARED_DEVICE.model or "")
    window = ScriptedSource(DEFAULT_SCRIPT)
    window._started_ms = 0.0
    produced = window.window_ending(5_000)
    assert produced.stream_id == "scripted-rehearsal-eeg"
    assert produced.provenance.producer_version == "scripted-rehearsal"


def test_score_at_follows_the_script_and_invalid_is_none() -> None:
    assert score_at(DEFAULT_SCRIPT, 0) == 80.0
    assert score_at(DEFAULT_SCRIPT, 31) == 10.0
    assert score_at(DEFAULT_SCRIPT, 120) is None
    assert score_at(DEFAULT_SCRIPT, float("nan")) is None
    assert score_at(DEFAULT_SCRIPT, 10_000) == 80.0


def test_brief_crossing_does_not_remind_sustained_episodes_do_and_cooldown_holds() -> None:
    events, states = run_script()
    times = [t for t, _ in events]
    assert len(times) == 2
    assert not any(t < 45 for t in times), "the 3 s crossing at 30 s must not remind"
    assert 54 <= times[0] <= 64
    assert times[1] - times[0] >= 30, "second reminder respects the 30 s cooldown"
    assert any(state == "cooldown" for _, state in states)
    for _, event in events:
        assert event.mode == "eeg_only" and event.provenance.run_kind == "live"


def test_invalid_windows_make_the_adapter_unknown_without_a_reminder() -> None:
    events, states = run_script()
    invalid_start = sum(duration for duration, _ in DEFAULT_SCRIPT[:6])
    in_dropout = [state for t, state in states if invalid_start + 3 <= t <= invalid_start + 9]
    assert in_dropout and set(in_dropout) == {"unknown"}
    assert not any(invalid_start <= t <= invalid_start + 10 for t, _ in events)


def test_each_live_session_restarts_the_script_from_its_start() -> None:
    class Clock:
        now = 5_000.0

        def now_ms(self) -> float:
            return self.now

    clock = Clock()
    source = ScriptedSource()
    source._clock, source._started_ms = clock, 0.0  # type: ignore[assignment]
    clock.now = 40_000.0
    source.on_live_session_started()
    assert source._started_ms == 40_000.0
