"""Scripted TEST EEG source for headset-free rehearsal of the live path. NEVER a device.

``oxford-backend serve --live-eeg-reminders --eeg-source integration.rehearsal.scripted_eeg:make_source``
(or ``npm run dev -- --rehearsal``) publishes model-score windows from a fixed script so the real backend
(hub, mapping, live EEG adapter, combined EEG+gaze when the browser calibrates a real webcam) can be
exercised without a Unicorn. It refuses to start unless ``OXFORD_REHEARSAL_EEG=1`` is set, declares itself
as ``Scripted test EEG (not a headset)`` in the session config (the page shows "Test EEG + real webcam"),
and uses its own stream id and producer version. The *score* it emits follows the current lecture-attention
interface (``attention_score``, ``score_0_100``, low = lapse); the thresholds, smoothing, dwell and cooldown
are applied by the inference adapter, not here.
"""

from __future__ import annotations

import math
import os
from collections.abc import Sequence
from threading import Event, Thread
from typing import Any

from oxford_hack.contracts.payloads import EegDeviceInfo, EegFeatureWindow
from oxford_hack.timing.clock import Clock

ENV_FLAG = "OXFORD_REHEARSAL_EEG"
STREAM_ID = "scripted-rehearsal-eeg"
DEVICE_LABEL = "Scripted test EEG (not a headset)"

# (duration_s, score). None = invalid window (unusable quality, which the adapter reports as unknown).
# After the script ends the last entry is held.
DEFAULT_SCRIPT: tuple[tuple[float, float | None], ...] = (
    (30.0, 80.0),  # focused: time to press play after the video loads
    (3.0, 10.0),  # brief crossing: must NOT remind (smoothing + 8 s dwell)
    (12.0, 80.0),
    (22.0, 10.0),  # sustained low: exactly one reminder
    (8.0, 80.0),  # recovery
    (40.0, 10.0),  # second low episode: held back by the 30 s cooldown, then reminds
    (10.0, None),  # sensor drops out: unknown, no reminder
    (600.0, 80.0),
)

DECLARED_DEVICE = EegDeviceInfo(
    model=DEVICE_LABEL, confirmed=False, sample_rate_hz=None, channel_names=None, units=None
)


def score_at(script: Sequence[tuple[float, float | None]], t_s: float) -> float | None:
    """Score at ``t_s`` seconds after the script started (the last entry is held)."""
    if not math.isfinite(t_s):
        return None
    elapsed = 0.0
    for duration, value in script:
        elapsed += duration
        if t_s < elapsed:
            return value
    return script[-1][1]


def scripted_window(end_ms: float, value: float | None) -> EegFeatureWindow:
    """One 2 s model-score window ending at ``end_ms`` (backend clock). ``None`` makes it unusable."""
    from inference.demo import eeg_window  # deferred: needs the repo root on sys.path

    data: dict[str, Any] = eeg_window().model_dump(by_alias=False)
    data.update(
        window_id=f"scripted-{int(end_ms)}",
        stream_id=STREAM_ID,
        t_processed_backend_ms=end_ms + 10,
        samples={"expected": 500, "received": 500},
        feature_set_version="lecture-attention-0.1.0",
        evidence={"start_backend_ms": end_ms - 2000, "end_backend_ms": end_ms},
        features=[
            {
                "name": "attention_score",
                "unit": "score_0_100",
                "channel": None,
                "value": value,
                "missing_reason": "scripted_invalid" if value is None else None,
            }
        ],
        provenance={
            "run_kind": "live",
            "producer": "lecture-attention-model",
            "producer_version": "scripted-rehearsal",
        },
    )
    if value is None:
        data["quality"]["usable"] = False
    return EegFeatureWindow.model_validate(data)


class ScriptedSource:
    stream_id = STREAM_ID
    declared_device = DECLARED_DEVICE
    interval_s = 0.5

    def __init__(self, script: Sequence[tuple[float, float | None]] = DEFAULT_SCRIPT) -> None:
        self.script = tuple(script)
        self._stop = Event()
        self._thread: Thread | None = None
        self._started_ms: float | None = None
        self._clock: Clock | None = None

    def on_live_session_started(self) -> None:
        """Each live session replays the script from its start (called by the bridge)."""
        if self._clock is not None:
            self._started_ms = self._clock.now_ms()

    def window_ending(self, end_ms: float) -> EegFeatureWindow:
        assert self._started_ms is not None
        return scripted_window(end_ms, score_at(self.script, (end_ms - self._started_ms) / 1000))

    def start(self, sink: Any, clock: Clock) -> None:
        self._clock = clock
        self._started_ms = clock.now_ms()

        def run() -> None:
            while not self._stop.wait(self.interval_s):
                now = clock.now_ms()
                if now - (self._started_ms or now) >= 2000:
                    sink.publish_window(self.window_ending(now - 10))

        self._thread = Thread(target=run, daemon=True, name="scripted-test-eeg")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)


def make_source() -> ScriptedSource:
    if os.environ.get(ENV_FLAG) != "1":
        raise ValueError(f"Scripted test EEG is rehearsal-only; set {ENV_FLAG}=1 to use it (never a headset)")
    return ScriptedSource()
