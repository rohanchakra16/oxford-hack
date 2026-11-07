"""SYNTHETIC producers for ``simulated`` sessions and tests. Nothing here is real data.

* SyntheticEegProducer  — fake feature windows and status with scripted quality changes.
* PlaceholderInference  — emits a review candidate every ``period_ms`` of eligible playback.
                          It reads no signal values: it exists only to exercise the contract
                          (eligibility handling, stable event ids, per-signal scores).

Both are only ever wired into sessions whose runKind is ``simulated``, and everything they emit
is labelled ``runKind: simulated`` / ``detectorId: placeholder-scripted``.
"""

from __future__ import annotations

import random
from collections import deque
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field

from ..contracts.base import AutomaticMode, OperatingMode
from ..contracts.payloads import (
    BackendInterval,
    ClockCorrection,
    ContributingSignal,
    DetectorInfo,
    EegChannelQuality,
    EegDeviceInfo,
    EegFeature,
    EegFeatureWindow,
    EegQualityFlag,
    EegStatus,
    EegWindowQuality,
    GazeCalibration,
    PlaybackEligibility,
    Provenance,
    ReviewCandidate,
    SampleCounts,
    SensorStatus,
    SignalScore,
)
from ..inference.interface import InferenceAdapter, MappedGazeObservation, SessionContext

SIM_EEG = Provenance(run_kind="simulated", producer="synthetic-eeg", producer_version="0.1.0")
SIM_INFERENCE = Provenance(run_kind="simulated", producer="placeholder-inference", producer_version="0.1.0")
SYNTHETIC_DEVICE = EegDeviceInfo(
    model="synthetic (not a device)",
    confirmed=False,
    sample_rate_hz=None,
    channel_names=["synthetic-1", "synthetic-2"],
    units=None,
)


@dataclass(frozen=True)
class QualityEvent:
    """Scripted condition relative to producer start.

    ``flatline``: windows unusable. ``dropout``: no data at all.
    ``elevated``: fake feature values drawn from [0.8, 1.0] (to drive a detector deterministically).
    """

    start_ms: float
    end_ms: float
    kind: str


@dataclass
class SyntheticEegProducer:
    window_ms: float = 4_000.0
    step_ms: float = 1_000.0
    latency_ms: float = 150.0
    seed: int = 1
    script: Sequence[QualityEvent] = ()
    stream_id: str = "synthetic-eeg"
    _start: float | None = None
    _next_window_end: float = 0.0
    _next_status: float = 0.0
    _n: int = 0
    _rng: random.Random = field(default_factory=random.Random)

    def __post_init__(self) -> None:
        self._rng = random.Random(self.seed)

    def _active(self, rel_ms: float, kind: str) -> bool:
        return any(e.kind == kind and e.start_ms <= rel_ms < e.end_ms for e in self.script)

    def poll(self, now_backend_ms: float) -> list[EegFeatureWindow | EegStatus]:
        if self._start is None:
            self._start = now_backend_ms
            self._next_window_end = now_backend_ms + self.window_ms
            self._next_status = now_backend_ms
        out: list[EegFeatureWindow | EegStatus] = []
        rel = now_backend_ms - self._start
        dropout = self._active(rel, "dropout")
        if now_backend_ms >= self._next_status and not dropout:
            warming = now_backend_ms < self._start + self.window_ms + self.latency_ms
            flags: list[EegQualityFlag] = ["units_unverified"]
            if warming:
                flags.append("settling")
            out.append(
                EegStatus(
                    stream_id=self.stream_id,
                    state="warming_up" if warming else "ok",
                    flags=flags,
                    device=SYNTHETIC_DEVICE,
                    dropped_packets=0,
                    t_backend_ms=now_backend_ms,
                    provenance=SIM_EEG,
                )
            )
            self._next_status = now_backend_ms + 2_000.0
        while now_backend_ms >= self._next_window_end + self.latency_ms:
            end = self._next_window_end
            self._next_window_end += self.step_ms
            if self._active(end - self._start, "dropout"):
                continue
            flat = self._active(end - self._start, "flatline")
            value_range = (0.8, 1.0) if self._active(end - self._start, "elevated") else (-1.0, 1.0)
            self._n += 1
            features = [
                EegFeature(
                    name="synthetic_value",
                    unit="a.u.",
                    channel=ch,
                    value=None if flat else round(self._rng.uniform(*value_range), 6),
                    missing_reason="flatline (synthetic)" if flat else None,
                )
                for ch in ("synthetic-1", "synthetic-2")
            ]
            out.append(
                EegFeatureWindow(
                    window_id=f"syn-eegw-{self._n}",
                    stream_id=self.stream_id,
                    feature_set_version="synthetic-features-0",
                    evidence=BackendInterval(
                        start_backend_ms=max(0.0, end - self.window_ms), end_backend_ms=end
                    ),
                    device_evidence_start_device_s=None,
                    device_evidence_end_device_s=None,
                    clock_correction=ClockCorrection(
                        method="same_clock", offset_s=0.0, drift_ppm=None, uncertainty_ms=0.0
                    ),
                    samples=SampleCounts(expected=512, received=512),
                    channels=["synthetic-1", "synthetic-2"],
                    features=features,
                    quality=EegWindowQuality(
                        usable=not flat,
                        flags=["flatline"] if flat else [],
                        channels=[
                            EegChannelQuality(
                                channel=ch,
                                state="bad" if flat else "good",
                                flags=["flatline"] if flat else [],
                            )
                            for ch in ("synthetic-1", "synthetic-2")
                        ],
                    ),
                    t_processed_backend_ms=end + self.latency_ms,
                    provenance=SIM_EEG,
                )
            )
        return out


@dataclass
class PlaceholderInference:
    """PLACEHOLDER, not a classifier. Emits one candidate per ``period_ms`` of eligible playback."""

    session_id: str
    window_ms: float = 4_000.0
    period_ms: float = 20_000.0
    decision_delay_ms: float = 200.0
    _since: float | None = None
    _epoch: int | None = None
    _mode: OperatingMode = "manual_only"
    _last_end: float = -1e18
    _n: int = 0
    _eeg_windows: deque[tuple[float, str]] = field(default_factory=lambda: deque(maxlen=32))
    _gaze_ids: deque[tuple[float, str]] = field(default_factory=lambda: deque(maxlen=512))
    closed: bool = False

    @property
    def detector(self) -> DetectorInfo:
        return DetectorInfo(
            detector_id="placeholder-scripted",
            detector_version="0.1.0",
            config_version=f"every-{int(self.period_ms)}ms",
        )

    @property
    def evaluated_modes(self) -> frozenset[AutomaticMode]:
        # Nothing evaluated. Simulated sessions publish via the hub's simulation-only policy.
        return frozenset()

    def on_eeg_window(self, window: EegFeatureWindow) -> None:
        self._eeg_windows.append((window.evidence.end_backend_ms, window.window_id))

    def on_gaze(self, observations: Sequence[MappedGazeObservation]) -> None:
        for o in observations:
            self._gaze_ids.append((o.t_backend_frame_ms, o.observation.observation_id))

    def on_gaze_calibration(self, calibration: GazeCalibration) -> None:
        pass

    def on_eligibility(self, eligibility: PlaybackEligibility) -> None:
        # Clear pending state and wait for a full window inside the new eligible period.
        self._epoch = eligibility.epoch
        self._since = eligibility.eligible_since_backend_ms if eligibility.eligible else None

    def on_sensor_status(self, status: SensorStatus) -> None:
        self._mode = status.mode

    def poll(self, now_backend_ms: float) -> list[ReviewCandidate]:
        if self.closed or self._since is None or self._mode == "manual_only":
            return []
        end = now_backend_ms - self.decision_delay_ms
        start = end - self.window_ms
        if start < self._since or end - max(self._since, self._last_end) < self.period_ms:
            return []
        signals: list[ContributingSignal] = []
        if self._mode in ("both", "eeg_only"):
            ids = [wid for t, wid in self._eeg_windows if start < t <= end + 1]
            signals.append(
                ContributingSignal(
                    signal="eeg",
                    window_ids=ids[-4:],
                    scores=[
                        SignalScore(
                            name="placeholder",
                            value=None,
                            scale="none",
                            missing_reason="placeholder: no model",
                        )
                    ],
                )
            )
        if self._mode in ("both", "gaze_only"):
            gids = [gid for t, gid in self._gaze_ids if start <= t <= end]
            signals.append(
                ContributingSignal(
                    signal="gaze",
                    window_ids=gids[-4:],
                    scores=[
                        SignalScore(
                            name="placeholder",
                            value=None,
                            scale="none",
                            missing_reason="placeholder: no model",
                        )
                    ],
                )
            )
        self._n += 1
        self._last_end = end
        return [
            ReviewCandidate(
                event_id=f"{self.session_id}-ph-{self._n}",
                detector=self.detector,
                mode=self._mode,
                evidence=BackendInterval(start_backend_ms=start, end_backend_ms=end),
                decision_backend_ms=now_backend_ms,
                eligibility_epoch=self._epoch,
                contributing_signals=signals,
                provenance=SIM_INFERENCE,
            )
        ]

    def close(self) -> None:
        self.closed = True


SimulationFactoryType = Callable[
    [SessionContext], "tuple[SyntheticEegProducer | None, InferenceAdapter | None]"
]


DetectorFactory = Callable[[SessionContext], InferenceAdapter | None]


def simulation_factory(
    *,
    period_ms: float = 20_000.0,
    script: Sequence[QualityEvent] = (),
    seed: int = 1,
    detector_factory: DetectorFactory | None = None,
) -> SimulationFactoryType:
    """Synthetic EEG producer plus a detector for simulated sessions.

    ``detector_factory`` defaults to PlaceholderInference; pass e.g. P3's
    ``inference.adapter.BaselineInference`` to exercise a real detector on synthetic data.
    """

    def factory(ctx: SessionContext) -> tuple[SyntheticEegProducer | None, InferenceAdapter | None]:
        eeg = SyntheticEegProducer(seed=seed, script=script) if ctx.eeg_enabled else None
        if detector_factory is not None:
            return eeg, detector_factory(ctx)
        return eeg, PlaceholderInference(ctx.session_id, period_ms=period_ms)

    return factory
