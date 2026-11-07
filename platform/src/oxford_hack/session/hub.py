"""The session hub: the single owner of shared decision state. Owner: Person 5.

Everything that touches sessions, clocks, playback segments, sensor status, candidates and
bookmarks happens here, on one event loop, driven by:

* ``attach`` / ``detach`` / ``receive``  — browser connections (from the WebSocket transport)
* ``ingest_internal``                    — EEG features/status and review candidates
* ``tick``                               — timers: heartbeats, clock pings, timeouts, inference polls

The hub never sleeps or reads the wall clock: time comes from the injected Clock, so tests and
replays are deterministic. It never pauses or seeks playback; it only suggests bookmarks.
"""

from __future__ import annotations

import itertools
import secrets
from collections import Counter, OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal, Protocol

from ..contracts import AnyMessage, ContractError, envelope, parse_message
from ..contracts import payloads as p
from ..contracts.base import Contract
from ..contracts.messages import BROWSER_TO_BACKEND, EnvelopeBase
from ..inference.interface import InferenceAdapter, InferenceFactory, MappedGazeObservation, SessionContext
from ..timing.clock import Clock
from ..timing.clock_sync import ClockEstimate, ClockSample, ClockSync
from ..timing.playback import DEFAULT_MAPPING, PlaybackTimeline, TelemetryRejected
from .sensors import SensorMonitor

Priority = Literal["control", "data", "status"]
"""``status`` messages may be dropped under backpressure; ``control``/``data`` never silently."""

PRIORITY: dict[str, Priority] = {
    "heartbeat": "status",
    "clock_ping": "control",
    "clock_status": "status",
    "playback_eligibility": "status",
    "sensor_status": "data",
    "candidate_rejected": "status",
}


class Connection(Protocol):
    connection_id: str

    def send(self, message: EnvelopeBase, priority: Priority) -> None: ...
    def close(self, code: int, reason: str) -> None: ...


class IdFactory:
    """Random ids in production; counter-based ids when seeded (tests, replay)."""

    def __init__(self, seed: str | None = None) -> None:
        self._seed = seed
        self._counter = itertools.count(1)

    def new(self, prefix: str) -> str:
        if self._seed is not None:
            return f"{prefix}-{self._seed}-{next(self._counter)}"
        return f"{prefix}-{secrets.token_hex(8)}"


@dataclass
class HubSettings:
    heartbeat_interval_ms: float = 2_000.0
    heartbeat_timeout_ms: float = 6_000.0
    session_grace_ms: float = 60_000.0
    clock_burst: int = 5
    clock_burst_interval_ms: float = 100.0
    clock_ping_interval_ms: float = 2_000.0
    clock_status_interval_ms: float = 1_000.0
    mapping: p.MappingConfig = DEFAULT_MAPPING
    gaze_batches_per_s: float = 20.0
    playback_messages_per_s: float = 50.0
    seen_event_capacity: int = 4_096
    allowed_run_kinds: frozenset[str] = frozenset({"live", "simulated"})
    simulation_policy_run_kinds: frozenset[str] = frozenset({"simulated"})
    """Run kinds whose sessions may publish from unevaluated modes (synthetic data only)."""
    experimental_live_modes: frozenset[str] = frozenset()
    """Explicit operator opt-in. Does not declare evaluation or enable arbitrary detectors."""


class SimulationBundle(Protocol):
    """Synthetic producers for a ``simulated`` session (see harness/synthetic.py)."""

    def poll(self, now_backend_ms: float) -> list[p.EegFeatureWindow | p.EegStatus]: ...


class LiveEegFeed(Protocol):
    """Real EEG source bridge (see eeg/bridge.py): drained on every tick, stopped on shutdown."""

    def poll(self, now_backend_ms: float) -> list[p.EegFeatureWindow | p.EegStatus]: ...
    def stop(self) -> None: ...


SimulationFactory = Callable[[SessionContext], tuple[SimulationBundle | None, InferenceAdapter | None]]


class _Bucket:
    def __init__(self, rate_per_s: float, now_ms: float) -> None:
        self.rate = rate_per_s
        self.tokens = rate_per_s * 2
        self.last = now_ms

    def take(self, now_ms: float) -> bool:
        self.tokens = min(self.rate * 2, self.tokens + (now_ms - self.last) / 1000.0 * self.rate)
        self.last = now_ms
        if self.tokens >= 1:
            self.tokens -= 1
            return True
        return False


@dataclass
class ClientState:
    """Per browser page load. The clock relationship survives reconnects of the same page."""

    client_instance_id: str
    clock: ClockSync = field(default_factory=ClockSync)


@dataclass
class ConnState:
    conn: Connection
    client: ClientState
    attached_ms: float
    last_inbound_ms: float
    last_heartbeat_ms: float
    next_ping_ms: float
    burst_remaining: int
    gaze_bucket: _Bucket
    playback_bucket: _Bucket
    session_id: str | None = None
    out_seq: int = 0
    last_in_seq: int = -1
    pings: dict[str, float] = field(default_factory=dict)
    last_clock_status_ms: float = -1e18


@dataclass
class Session:
    id: str
    client_instance_id: str
    config: p.SessionConfig
    timeline: PlaybackTimeline
    monitor: SensorMonitor
    inference: InferenceAdapter | None
    simulation: SimulationBundle | None
    conn: ConnState | None = None
    disconnected_since_ms: float | None = None
    out_seq: int = 0
    bookmarks: dict[str, p.ReviewBookmark] = field(default_factory=dict)
    seen_events: OrderedDict[str, None] = field(default_factory=OrderedDict)
    pending: list[tuple[p.ReviewCandidate, float]] = field(default_factory=list)
    eligibility_key: tuple[bool, str, str | None] | None = None
    epoch: int = 0
    counters: Counter[str] = field(default_factory=Counter)
    feedback: list[p.UserFeedback] = field(default_factory=list)


Recorder = Callable[[str, AnyMessage, float], None]
"""(source, message, backend_ms). Called for every accepted inbound/internal message (never hello)."""


class Hub:
    def __init__(
        self,
        clock: Clock,
        *,
        settings: HubSettings | None = None,
        inference_factory: InferenceFactory | None = None,
        simulation_factory: SimulationFactory | None = None,
        ids: IdFactory | None = None,
        backend_instance_id: str | None = None,
        recorder: Recorder | None = None,
        eeg_device: p.EegDeviceInfo | None = None,
        live_eeg: LiveEegFeed | None = None,
    ) -> None:
        self.clock = clock
        self.settings = settings or HubSettings()
        self.ids = ids or IdFactory()
        self.backend_instance_id = backend_instance_id or self.ids.new("be")
        self._inference_factory = inference_factory
        self._simulation_factory = simulation_factory
        self._recorder = recorder
        self._eeg_device = eeg_device
        self._live_eeg = live_eeg
        self.clients: dict[str, ClientState] = {}
        self.conns: dict[str, ConnState] = {}
        self.sessions: dict[str, Session] = {}
        self.ended_sessions: OrderedDict[str, str] = OrderedDict()
        self.counters: Counter[str] = Counter()

    # ------------------------------------------------------------------ connections

    def attach(self, conn: Connection, hello: p.ClientHello) -> ConnState:
        """Register an authenticated connection and answer its ClientHello."""
        now = self.clock.now_ms()
        client = self.clients.setdefault(hello.client_instance_id, ClientState(hello.client_instance_id))
        st = ConnState(
            conn=conn,
            client=client,
            attached_ms=now,
            last_inbound_ms=now,
            last_heartbeat_ms=now,
            next_ping_ms=now,
            burst_remaining=self.settings.clock_burst,
            gaze_bucket=_Bucket(self.settings.gaze_batches_per_s, now),
            playback_bucket=_Bucket(self.settings.playback_messages_per_s, now),
        )
        self.conns[conn.connection_id] = st

        outcome: p.ResumeOutcome = "new"
        session: Session | None = None
        r = hello.resume
        if r is not None:
            if r.backend_instance_id != self.backend_instance_id:
                outcome = "backend_restarted"
            elif r.session_id in self.ended_sessions:
                outcome = "session_expired"
            else:
                cand = self.sessions.get(r.session_id)
                if cand is None or cand.client_instance_id != hello.client_instance_id:
                    outcome = "session_unknown"
                else:
                    outcome, session = "resumed", cand
        self._send_conn(
            st,
            "server_hello",
            p.ServerHello(
                backend_instance_id=self.backend_instance_id,
                connection_id=conn.connection_id,
                resume_outcome=outcome,
                session_id=session.id if session else None,
                heartbeat_interval_ms=self.settings.heartbeat_interval_ms,
                heartbeat_timeout_ms=self.settings.heartbeat_timeout_ms,
                t_backend_ms=now,
            ),
        )
        if session is not None:
            if session.conn is not None and session.conn is not st:
                old = session.conn
                self._drop_conn(old)
                old.conn.close(4409, "superseded by a newer connection for this session")
            self._bind(st, session)
            self._send(
                session,
                "session_snapshot",
                p.SessionSnapshot(
                    config=session.config,
                    bookmarks=list(session.bookmarks.values()),
                    sensor_status=session.monitor.status(now),
                    last_seq=session.out_seq,
                ),
            )
        self.counters[f"hello_{outcome}"] += 1
        return st

    def detach(self, conn: Connection) -> None:
        st = self.conns.get(conn.connection_id)
        if st is not None:
            self._drop_conn(st)

    def _drop_conn(self, st: ConnState) -> None:
        self.conns.pop(st.conn.connection_id, None)
        if st.session_id and (s := self.sessions.get(st.session_id)) and s.conn is st:
            s.conn = None
            s.disconnected_since_ms = self.clock.now_ms()

    def _bind(self, st: ConnState, session: Session) -> None:
        st.session_id = session.id
        session.conn = st
        session.disconnected_since_ms = None

    # ------------------------------------------------------------------ sending

    def _envelope(self, msg_type: str, payload: Contract, session_id: str | None, seq: int) -> AnyMessage:
        return envelope(msg_type, payload, message_id=self.ids.new("m"), session_id=session_id, seq=seq)

    def _send_conn(self, st: ConnState, msg_type: str, payload: Contract) -> None:
        """Pre-session / connection-level message (seq namespace: this connection)."""
        msg = self._envelope(msg_type, payload, None, st.out_seq)
        st.out_seq += 1
        st.conn.send(msg, PRIORITY.get(msg_type, "control"))

    def _send(self, session: Session, msg_type: str, payload: Contract) -> None:
        """Session message (seq namespace: this session, continuous across reconnects)."""
        msg = self._envelope(msg_type, payload, session.id, session.out_seq)
        session.out_seq += 1
        if session.conn is not None:
            session.conn.conn.send(msg, PRIORITY.get(msg_type, "data"))

    def _error(
        self,
        st: ConnState,
        code: p.ErrorCode,
        message: str,
        *,
        ref: str | None = None,
        fatal: bool = False,
        **details: str | int | float | bool | None,
    ) -> None:
        self.counters[f"error_{code}"] += 1
        report = p.ErrorReport(
            code=code, message=message[:500], ref_message_id=ref, fatal=fatal, details=details
        )
        session = self.sessions.get(st.session_id) if st.session_id else None
        if session is not None:
            self._send(session, "error", report)
        else:
            self._send_conn(st, "error", report)
        if fatal:
            self._drop_conn(st)
            st.conn.close(4400, code)

    # ------------------------------------------------------------------ inbound from browser

    def receive(self, conn: Connection, raw: str | bytes) -> None:
        st = self.conns.get(conn.connection_id)
        if st is None:
            return
        now = self.clock.now_ms()
        st.last_inbound_ms = now
        try:
            msg = parse_message(raw, allowed_types=BROWSER_TO_BACKEND - {"client_hello"})
        except ContractError as err:
            fatal = err.code == "schema_version_mismatch"
            self._error(st, err.code, err.message, ref=err.message_id, fatal=fatal)
            return
        if msg.seq <= st.last_in_seq:
            self._error(
                st, "out_of_order", f"seq {msg.seq} <= last accepted {st.last_in_seq}", ref=msg.message_id
            )
            return
        st.last_in_seq = msg.seq
        self._dispatch(st, msg, now)

    def _session_for(self, st: ConnState, msg: AnyMessage) -> Session | None:
        if msg.session_id is None or msg.session_id != st.session_id:
            if msg.session_id is not None and (
                msg.session_id in self.ended_sessions or msg.session_id in self.sessions
            ):
                self._error(
                    st,
                    "obsolete_session",
                    f"session {msg.session_id} is not this connection's active session",
                    ref=msg.message_id,
                )
            else:
                self._error(st, "no_session", f"{msg.type} needs an active session", ref=msg.message_id)
            return None
        return self.sessions.get(msg.session_id)

    def _dispatch(self, st: ConnState, msg: AnyMessage, now: float) -> None:
        t = msg.type
        if t == "heartbeat":
            return
        if t == "clock_pong":
            self._on_pong(st, msg.payload, now)  # type: ignore[arg-type]
            return
        if t == "error":
            self.counters["browser_reported_error"] += 1
            return
        if t == "session_start":
            self._record("browser", msg, now)
            self._start_session(st, msg.payload, msg.message_id, now)  # type: ignore[arg-type]
            return
        session = self._session_for(st, msg)
        if session is None:
            return
        self._record("browser", msg, now)
        if t == "session_end":
            self._end_session(session, "client_ended")
        elif t == "playback_state":
            if not st.playback_bucket.take(now):
                self._error(st, "rate_limited", "playback_state rate exceeded", ref=msg.message_id)
                return
            self._on_playback(st, session, msg.payload, msg.message_id, now)  # type: ignore[arg-type]
        elif t == "gaze_observations":
            if not st.gaze_bucket.take(now):
                session.counters["gaze_rate_limited"] += 1
                return
            self._on_gaze(st, session, msg.payload, msg.message_id, now)  # type: ignore[arg-type]
        elif t == "gaze_calibration":
            cal: p.GazeCalibration = msg.payload  # type: ignore[assignment]
            if cal.provenance.run_kind != session.config.run_kind:
                self._error(
                    st,
                    "invalid_message",
                    "gaze provenance runKind does not match session",
                    ref=msg.message_id,
                )
                return
            session.monitor.on_calibration(cal)
            if session.inference:
                session.inference.on_gaze_calibration(cal)
        elif t == "manual_bookmark":
            self._on_manual(st, session, msg.payload, msg.message_id, now)  # type: ignore[arg-type]
        elif t == "user_feedback":
            fb: p.UserFeedback = msg.payload  # type: ignore[assignment]
            if fb.bookmark_id not in session.bookmarks:
                self._error(st, "invalid_message", f"unknown bookmark {fb.bookmark_id}", ref=msg.message_id)
                return
            session.feedback.append(fb)
            session.counters[f"feedback_{fb.action}"] += 1

    def _on_pong(self, st: ConnState, pong: p.ClockPong, now: float) -> None:
        sent = st.pings.pop(pong.ping_id, None)
        if sent is None or sent != pong.t_backend_send_ms:
            self.counters["clock_pong_unmatched"] += 1
            return
        st.client.clock.add(ClockSample(sent, pong.t_browser_recv_ms, pong.t_browser_send_ms, now))

    # ------------------------------------------------------------------ sessions

    def _start_session(self, st: ConnState, req: p.SessionStart, ref: str, now: float) -> None:
        if st.session_id is not None and st.session_id in self.sessions:
            self._error(
                st,
                "invalid_message",
                "a session is already active on this connection; send session_end first",
                ref=ref,
            )
            return
        if req.run_kind not in self.settings.allowed_run_kinds:
            self._error(
                st,
                "invalid_message",
                f"runKind {req.run_kind!r} is not accepted by this backend "
                f"(allowed: {sorted(self.settings.allowed_run_kinds)})",
                ref=ref,
            )
            return
        session_id = self.ids.new("ses")
        ctx = SessionContext(
            session_id, req.video_id, req.run_kind, req.requested_sensors.eeg, req.requested_sensors.gaze
        )
        simulation: SimulationBundle | None = None
        inference: InferenceAdapter | None = None
        if req.run_kind == "simulated":
            if self._simulation_factory is None:
                self._error(
                    st, "invalid_message", "simulated sessions are not configured on this backend", ref=ref
                )
                return
            simulation, inference = self._simulation_factory(ctx)
        elif self._inference_factory is not None:
            inference = self._inference_factory(ctx)

        def policy_for(mode: str) -> p.ModePolicyValue:
            # Simulation-only policy: in a simulated run every mode may publish (labelled 'simulated')
            # suggestions so the pipeline can be exercised. This is NOT evaluation evidence. Live and
            # replay sessions allow only modes the detector bundle declares evaluated.
            if inference is None:
                return "manual_only"
            if req.run_kind in self.settings.simulation_policy_run_kinds:
                return "automatic"
            if (
                req.run_kind == "live"
                and mode in self.settings.experimental_live_modes
                and mode in getattr(inference, "experimental_modes", frozenset())
            ):
                return "automatic"
            return "automatic" if mode in inference.evaluated_modes else "manual_only"

        policy = p.ModePolicy(
            both=policy_for("both"), eeg_only=policy_for("eeg_only"), gaze_only=policy_for("gaze_only")
        )
        device = (
            self._eeg_device
            if req.run_kind == "live"
            else p.EegDeviceInfo(
                model="synthetic (not a device)",
                confirmed=False,
                sample_rate_hz=None,
                channel_names=None,
                units=None,
            )
        )
        config = p.SessionConfig(
            session_id=session_id,
            video_id=req.video_id,
            run_kind=req.run_kind,
            enabled_sensors=req.requested_sensors,
            mode_policy=policy,
            detector=inference.detector if inference else None,
            eeg_device=device if req.requested_sensors.eeg else None,
            feature_set_version=None,
            mapping=self.settings.mapping,
            created_backend_ms=now,
        )
        timeline = PlaybackTimeline(req.video_id)
        timeline.media_duration_s = req.media_duration_s
        session = Session(
            id=session_id,
            client_instance_id=st.client.client_instance_id,
            config=config,
            timeline=timeline,
            monitor=SensorMonitor(
                eeg_enabled=req.requested_sensors.eeg,
                gaze_enabled=req.requested_sensors.gaze,
                policy=policy,
                has_detector=inference is not None,
                experimental_modes=(
                    self.settings.experimental_live_modes
                    & getattr(inference, "experimental_modes", frozenset())
                    if req.run_kind == "live"
                    else frozenset()
                ),
                run_kind=req.run_kind,
            ),
            inference=inference,
            simulation=simulation,
        )
        self.sessions[session_id] = session
        if req.run_kind == "live" and req.requested_sensors.eeg and self._live_eeg is not None:
            # Optional: a rehearsal source restarts its script for each session; a headset ignores this.
            notify = getattr(self._live_eeg, "session_started", None)
            if callable(notify):
                notify()
        self._bind(st, session)
        self._send(session, "session_config", config)
        self._update_status(session, now, force=True)
        self.counters["sessions_started"] += 1

    def _end_session(
        self, session: Session, reason: Literal["client_ended", "expired", "superseded", "backend_shutdown"]
    ) -> None:
        self._send(session, "session_ended", p.SessionEnded(reason=reason))
        if session.inference is not None:
            session.inference.close()
        for cand, _ in session.pending:
            self._reject(
                session, cand.event_id, "obsolete_session", "session ended while candidate was pending"
            )
        session.pending.clear()
        if session.conn is not None:
            session.conn.session_id = None
        self.sessions.pop(session.id, None)
        self.ended_sessions[session.id] = reason
        while len(self.ended_sessions) > 1_000:
            self.ended_sessions.popitem(last=False)

    def shutdown(self) -> None:
        for s in list(self.sessions.values()):
            self._end_session(s, "backend_shutdown")
        if self._live_eeg is not None:
            self._live_eeg.stop()

    # ------------------------------------------------------------------ playback

    def _on_playback(
        self, st: ConnState, session: Session, state: p.PlaybackState, ref: str, now: float
    ) -> None:
        try:
            session.timeline.ingest(state, now, staleness_ms=self.settings.mapping.max_telemetry_staleness_ms)
        except TelemetryRejected as err:
            code: p.ErrorCode = "video_mismatch" if err.code == "video_mismatch" else "out_of_order"
            self._error(st, code, err.message, ref=ref)
            return
        self._update_eligibility(session, now)
        self._retry_pending(session, now)

    def _update_eligibility(self, session: Session, now: float) -> None:
        clock = self._clock_for(session, now)
        e = session.timeline.eligibility(now, clock, session.config.mapping)
        key = (e.eligible, e.reason, e.segment_id)
        if key == session.eligibility_key:
            return
        session.eligibility_key = key
        session.epoch += 1
        msg = p.PlaybackEligibility(
            video_id=session.config.video_id,
            segment_id=e.segment_id,
            eligible=e.eligible,
            reason=e.reason,
            epoch=session.epoch,
            eligible_since_backend_ms=e.since_backend_ms,
            t_backend_ms=now,
        )
        if session.inference is not None:
            session.inference.on_eligibility(msg)
        self._send(session, "playback_eligibility", msg)

    def _clock_for(self, session: Session, now: float) -> ClockEstimate | None:
        client = self.clients.get(session.client_instance_id)
        return client.clock.usable(now) if client else None

    # ------------------------------------------------------------------ gaze, manual

    def _on_gaze(
        self, st: ConnState, session: Session, batch: p.GazeObservationBatch, ref: str, now: float
    ) -> None:
        if batch.provenance.run_kind != session.config.run_kind:
            self._error(st, "invalid_message", "gaze provenance runKind does not match session", ref=ref)
            return
        if not session.config.enabled_sensors.gaze:
            session.counters["gaze_ignored_disabled"] += 1
            return
        session.monitor.on_gaze(batch, now)
        clock = self._clock_for(session, now)
        if clock is None:
            session.counters["gaze_unmapped_clock"] += len(batch.observations)
            return
        mapped = [
            MappedGazeObservation(
                o, max(0.0, clock.browser_to_backend(o.t_browser_frame_ms)), clock.uncertainty_ms
            )
            for o in batch.observations
        ]
        if session.inference is not None:
            session.inference.on_gaze(mapped)

    def _on_manual(self, st: ConnState, session: Session, m: p.ManualBookmark, ref: str, now: float) -> None:
        if m.video_id != session.config.video_id:
            self._error(st, "video_mismatch", "manual bookmark for a different video", ref=ref)
            return
        if m.bookmark_id in session.bookmarks:
            session.counters["manual_duplicate"] += 1
            return
        duration = session.timeline.media_duration_s
        if duration is not None and m.media_time_s > duration + 0.5:
            self._error(st, "invalid_message", "manual bookmark beyond media duration", ref=ref)
            return
        bm = p.ReviewBookmark(
            bookmark_id=m.bookmark_id,
            event_id=None,
            video_id=m.video_id,
            segment_id=None,
            source="manual",
            run_kind=session.config.run_kind,
            suggested_media_s=m.media_time_s,
            evidence_media=None,
            evidence=None,
            decision_backend_ms=None,
            mapped_backend_ms=now,
            mapping_uncertainty_ms=None,
            detector=None,
            contributing_signals=[],
            transcript_context=None,
        )
        session.bookmarks[bm.bookmark_id] = bm
        self._send(session, "review_bookmark", bm)

    # ------------------------------------------------------------------ internal (EEG, inference)

    def ingest_internal(
        self, message: p.EegFeatureWindow | p.EegStatus | p.ReviewCandidate, *, session_id: str | None = None
    ) -> None:
        """Accept a validated payload from P1 or P3.

        EEG goes to matching sessions; candidates need ``session_id``.
        """
        now = self.clock.now_ms()
        if isinstance(message, p.ReviewCandidate):
            session = self.sessions.get(session_id or "")
            if session is None:
                self.counters["candidate_obsolete_session"] += 1
                return
            self._on_candidate(session, message, now)
            return
        targets = (
            [self.sessions[session_id]]
            if session_id in self.sessions
            else ([] if session_id else list(self.sessions.values()))
        )
        for session in targets:
            self._on_eeg(session, message, now)

    def _on_eeg(self, session: Session, message: p.EegFeatureWindow | p.EegStatus, now: float) -> None:
        if not session.config.enabled_sensors.eeg or message.provenance.run_kind != session.config.run_kind:
            return
        self._record(
            "eeg",
            self._envelope(
                "eeg_status" if isinstance(message, p.EegStatus) else "eeg_features", message, session.id, 0
            ),
            now,
        )
        if isinstance(message, p.EegStatus):
            session.monitor.on_eeg_status(message, now)
            return
        age = now - message.evidence.end_backend_ms
        if age > session.config.mapping.max_candidate_age_ms:
            session.counters["eeg_window_stale"] += 1
            return
        session.monitor.on_eeg_window(message, now)
        if session.inference is not None:
            session.inference.on_eeg_window(message)

    def _reject(
        self, session: Session, event_id: str | None, reason: p.CandidateRejectionReason, detail: str
    ) -> None:
        session.counters[f"candidate_{reason}"] += 1
        self._send(
            session,
            "candidate_rejected",
            p.CandidateRejected(event_id=event_id, reason=reason, detail=detail),
        )

    def _on_candidate(self, session: Session, c: p.ReviewCandidate, now: float) -> None:
        if c.event_id in session.seen_events:
            self._reject(session, c.event_id, "duplicate", "event already received")
            return
        session.seen_events[c.event_id] = None
        while len(session.seen_events) > self.settings.seen_event_capacity:
            session.seen_events.popitem(last=False)
        self._record("inference", self._envelope("review_candidate", c, session.id, 0), now)
        if c.provenance.run_kind != session.config.run_kind:
            self._reject(session, c.event_id, "invalid", "candidate runKind does not match session")
            return
        if now - c.decision_backend_ms > session.config.mapping.max_candidate_age_ms:
            self._reject(session, c.event_id, "too_old", "decision is older than maxCandidateAgeMs")
            return
        if getattr(session.config.mode_policy, c.mode) != "automatic":
            self._reject(
                session, c.event_id, "mode_not_automatic", f"mode {c.mode} is manual-only in this session"
            )
            return
        self._try_map(session, c, now, now)

    def _try_map(self, session: Session, c: p.ReviewCandidate, received: float, now: float) -> bool:
        """Map or reject. Returns False if the candidate stays pending."""
        outcome = session.timeline.map_evidence(
            c.evidence, self._clock_for(session, now), session.config.mapping
        )
        if outcome.pending:
            if now - received > session.config.mapping.pending_timeout_ms:
                self._reject(
                    session,
                    c.event_id,
                    "stale_telemetry",
                    "no telemetry confirmed playback over the evidence",
                )
                return True
            if all(pc.event_id != c.event_id for pc, _ in session.pending):
                session.pending.append((c, received))
            return False
        if outcome.rejection is not None:
            self._reject(session, c.event_id, outcome.rejection, outcome.detail)
            return True
        m = outcome.mapped
        assert m is not None
        if m.video_id != session.config.video_id:
            self._reject(session, c.event_id, "video_mismatch", "evidence belongs to another video")
            return True
        source: p.BookmarkSource = {
            "both": "experimental_combined",
            "eeg_only": "experimental_eeg",
            "gaze_only": "experimental_gaze",
        }[c.mode]  # type: ignore[assignment]
        bm = p.ReviewBookmark(
            bookmark_id=f"bm-{c.event_id}",
            event_id=c.event_id,
            video_id=m.video_id,
            segment_id=m.segment_id,
            source=source,
            run_kind=session.config.run_kind,
            suggested_media_s=max(0.0, m.evidence_media.start_media_s - session.config.mapping.lead_in_s),
            evidence_media=m.evidence_media,
            evidence=c.evidence,
            decision_backend_ms=c.decision_backend_ms,
            mapped_backend_ms=now,
            mapping_uncertainty_ms=m.uncertainty_ms,
            detector=c.detector,
            contributing_signals=c.contributing_signals,
            transcript_context=None,
        )
        session.bookmarks[bm.bookmark_id] = bm
        session.counters["bookmarks_mapped"] += 1
        self._send(session, "review_bookmark", bm)
        return True

    def _retry_pending(self, session: Session, now: float) -> None:
        if not session.pending:
            return
        still = []
        for cand, received in session.pending:
            if not self._try_map(session, cand, received, now):
                still.append((cand, received))
        session.pending = still

    # ------------------------------------------------------------------ timers

    def _update_status(self, session: Session, now: float, *, force: bool = False) -> None:
        status = session.monitor.changed(now)
        if status is None and force:
            status = session.monitor.status(now)
        if status is None:
            return
        if session.inference is not None:
            session.inference.on_sensor_status(status)
        self._send(session, "sensor_status", status)

    def tick(self) -> None:
        now = self.clock.now_ms()
        s = self.settings
        for st in list(self.conns.values()):
            if now - st.last_inbound_ms > s.heartbeat_timeout_ms:
                self.counters["heartbeat_timeouts"] += 1
                self._drop_conn(st)
                st.conn.close(4000, "heartbeat timeout")
                continue
            if now - st.last_heartbeat_ms >= s.heartbeat_interval_ms:
                st.last_heartbeat_ms = now
                self._send_conn_or_session(st, "heartbeat", p.Heartbeat(clock="backend", sent_ms=now))
            if now >= st.next_ping_ms:
                ping_id = self.ids.new("ping")
                st.pings[ping_id] = now
                if len(st.pings) > 32:
                    st.pings.pop(next(iter(st.pings)))
                self._send_conn_or_session(
                    st, "clock_ping", p.ClockPing(ping_id=ping_id, t_backend_send_ms=now)
                )
                if st.burst_remaining > 0:
                    st.burst_remaining -= 1
                    st.next_ping_ms = now + s.clock_burst_interval_ms
                else:
                    st.next_ping_ms = now + s.clock_ping_interval_ms
            if now - st.last_clock_status_ms >= s.clock_status_interval_ms:
                st.last_clock_status_ms = now
                est = st.client.clock.estimate(now)
                self._send_conn_or_session(
                    st,
                    "clock_status",
                    p.ClockStatus(
                        state=est.state if est else "unsynchronised",
                        offset_browser_minus_backend_ms=est.offset_browser_minus_backend_ms if est else None,
                        uncertainty_ms=est.uncertainty_ms if est else None,
                        best_rtt_ms=est.best_rtt_ms if est else None,
                        sample_count=est.sample_count if est else 0,
                        t_backend_ms=now,
                    ),
                )
        live_items = self._live_eeg.poll(now) if self._live_eeg is not None else []
        for session in list(self.sessions.values()):
            if session.config.run_kind == "live":
                for item in live_items:
                    self._on_eeg(session, item, now)
            if (
                session.conn is None
                and session.disconnected_since_ms is not None
                and (now - session.disconnected_since_ms > s.session_grace_ms)
            ):
                self._end_session(session, "expired")
                continue
            if session.simulation is not None:
                for item in session.simulation.poll(now):
                    self._on_eeg(session, item, now)
            self._update_eligibility(session, now)
            self._update_status(session, now)
            if session.inference is not None:
                for cand in session.inference.poll(now):
                    self._on_candidate(session, cand, now)
            self._retry_pending(session, now)
            clock = self._clock_for(session, now)
            if clock is not None:
                session.timeline.prune(clock.backend_to_browser(now))

    def _send_conn_or_session(self, st: ConnState, msg_type: str, payload: Contract) -> None:
        session = self.sessions.get(st.session_id) if st.session_id else None
        if session is not None and session.conn is st:
            self._send(session, msg_type, payload)
        else:
            self._send_conn(st, msg_type, payload)

    def _record(self, source: str, msg: AnyMessage, now: float) -> None:
        if self._recorder is None or msg.type == "client_hello":
            return
        clock_hook = getattr(self._recorder, "clock_offset", None)
        if clock_hook is not None and msg.session_id in self.sessions:
            est = self._clock_for(self.sessions[msg.session_id], now)
            clock_hook(est.offset_browser_minus_backend_ms if est else None)
        elif clock_hook is not None and msg.type == "session_start":
            for st in self.conns.values():
                est = st.client.clock.usable(now)
                if est is not None:
                    clock_hook(est.offset_browser_minus_backend_ms)
                    break
        self._recorder(source, msg, now)
