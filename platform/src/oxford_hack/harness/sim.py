"""Deterministic discrete-event simulator: a SYNTHETIC browser, media player and network
talking to a real Hub through the real wire format (JSON strings, full validation).

Used by tests and by the replay tool. Time is a ManualClock; nothing sleeps. The browser clock
is ``backend + offset_ms`` and network delays are seeded random draws, so a non-zero clock
offset and asymmetric jitter are exercised on every run.
"""

from __future__ import annotations

import heapq
import itertools
import json
import random
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from ..contracts import dumps, envelope, parse_message
from ..contracts import payloads as p
from ..contracts.base import Contract
from ..contracts.messages import EnvelopeBase
from ..session.hub import Hub, Priority
from ..timing.clock import ManualClock

SIM_GAZE = p.Provenance(run_kind="simulated", producer="sim-browser-gaze", producer_version="0.1.0")


class Scheduler:
    def __init__(self, clock: ManualClock) -> None:
        self.clock = clock
        self._queue: list[tuple[float, int, Callable[[], None]]] = []
        self._order = itertools.count()

    def at(self, t_ms: float, fn: Callable[[], None]) -> None:
        heapq.heappush(self._queue, (max(t_ms, self.clock.now_ms()), next(self._order), fn))

    def run_until(self, t_ms: float, hub: Hub, *, tick_ms: float = 50.0) -> None:
        next_tick = self.clock.now_ms()
        while True:
            next_event = self._queue[0][0] if self._queue else float("inf")
            t = min(next_event, next_tick)
            if t > t_ms:
                break
            self.clock.set(t)
            if t == next_tick:
                hub.tick()
                next_tick += tick_ms
            while self._queue and self._queue[0][0] <= t:
                _, _, fn = heapq.heappop(self._queue)
                fn()
        self.clock.set(t_ms)


@dataclass
class Network:
    rng: random.Random
    base_delay_ms: float = 2.0
    jitter_ms: float = 3.0

    def delay(self) -> float:
        return self.base_delay_ms + self.rng.random() * self.jitter_ms


class SimConnection:
    """The hub's view of the simulated WebSocket."""

    def __init__(self, browser: SimBrowser, connection_id: str) -> None:
        self.connection_id = connection_id
        self._browser = browser
        self.closed: tuple[int, str] | None = None
        self.dropped_status = 0
        self.last_down_ms = 0.0  # WebSockets are FIFO: never deliver out of order
        self.last_up_ms = 0.0

    def send(self, message: EnvelopeBase, priority: Priority) -> None:
        if self.closed:
            return
        text = dumps(message)
        sim = self._browser.sim
        self.last_down_ms = max(self.last_down_ms, sim.clock.now_ms() + sim.net.delay())
        sim.scheduler.at(self.last_down_ms, lambda: self._browser._deliver(self, text))

    def close(self, code: int, reason: str) -> None:
        if self.closed:
            return
        self.closed = (code, reason)
        # The close frame arrives after everything already in flight (e.g. a fatal error report).
        sim = self._browser.sim
        self.last_down_ms = max(self.last_down_ms, sim.clock.now_ms() + sim.net.delay())
        sim.scheduler.at(self.last_down_ms, lambda: self._browser._closed(self, code, reason))


@dataclass
class SimBrowser:
    sim: Sim
    offset_ms: float
    client_instance_id: str
    session_token: str = "tok_sim_0123456789abcdef"
    received: list[dict[str, Any]] = field(default_factory=list)
    conn: SimConnection | None = None
    backend_instance_id: str | None = None
    session_id: str | None = None
    last_session_seq: int = -1
    seq: int = 0
    answer_pings: bool = True
    closes: list[tuple[int, str]] = field(default_factory=list)
    _conn_n: int = 0

    def now(self) -> float:
        return self.sim.clock.now_ms() + self.offset_ms

    # -- connection
    def connect(self, *, resume: bool = False) -> None:
        self._conn_n += 1
        self.conn = SimConnection(self, f"{self.client_instance_id}-conn-{self._conn_n}")
        resume_req = None
        if resume and self.session_id and self.backend_instance_id:
            resume_req = p.ResumeRequest(
                session_id=self.session_id,
                backend_instance_id=self.backend_instance_id,
                last_received_seq=max(0, self.last_session_seq),
            )
        hello = p.ClientHello(
            client_instance_id=self.client_instance_id,
            session_token=self.session_token,
            resume=resume_req,
            capabilities=p.ClientCapabilities(playback_telemetry=True, gaze=True, diagnostics=True),
            t_browser_ms=self.now(),
        )
        self.sim.hub.attach(self.conn, hello)

    def disconnect(self) -> None:
        if self.conn is not None:
            self.sim.hub.detach(self.conn)
            self.conn.closed = (1000, "browser closed")
            self.conn = None

    def _closed(self, conn: SimConnection, code: int, reason: str) -> None:
        self.closes.append((code, reason))
        if self.conn is conn:
            self.conn = None

    # -- outbound
    def send(self, msg_type: str, payload: Contract, *, session_id: str | None = "current") -> None:
        sid = self.session_id if session_id == "current" else session_id
        msg = envelope(
            msg_type,
            payload,
            message_id=f"b{self.client_instance_id}-{self.seq}",
            session_id=sid,
            seq=self.seq,
        )
        self.seq += 1
        self.send_raw(dumps(msg))

    def send_raw(self, text: str) -> None:
        conn = self.conn
        if conn is None:
            return
        conn.last_up_ms = max(conn.last_up_ms, self.sim.clock.now_ms() + self.sim.net.delay())
        self.sim.scheduler.at(
            conn.last_up_ms, lambda: self.sim.hub.receive(conn, text) if conn.closed is None else None
        )

    # -- inbound
    def _deliver(self, conn: SimConnection, text: str) -> None:
        if conn is not self.conn and not (self.conn is None and conn.closed):
            return
        msg = parse_message(text)  # the browser validates everything it receives
        obj = json.loads(text)
        self.received.append(obj)
        if msg.session_id is not None:
            self.last_session_seq = msg.seq
        if msg.type == "server_hello":
            self.backend_instance_id = msg.payload.backend_instance_id
            if msg.payload.resume_outcome != "resumed":
                self.session_id = None
        elif msg.type in ("session_config",):
            self.session_id = msg.payload.session_id
        elif msg.type == "session_ended":
            self.session_id = None
        elif msg.type == "clock_ping" and self.answer_pings:
            ping = msg.payload
            recv = self.now()
            self.send(
                "clock_pong",
                p.ClockPong(
                    ping_id=ping.ping_id,
                    t_backend_send_ms=ping.t_backend_send_ms,
                    t_browser_recv_ms=recv,
                    t_browser_send_ms=recv + 0.2,
                ),
                session_id=self.session_id,
            )

    def of_type(self, msg_type: str) -> list[dict[str, Any]]:
        return [m for m in self.received if m["type"] == msg_type]

    def start_session(
        self,
        video_id: str,
        *,
        run_kind: str = "simulated",
        eeg: bool = True,
        gaze: bool = False,
        duration_s: float | None = 600.0,
    ) -> None:
        self.send(
            "session_start",
            p.SessionStart(
                video_id=video_id,
                run_kind=run_kind,  # type: ignore[arg-type]
                requested_sensors=p.RequestedSensors(eeg=eeg, gaze=gaze),
                media_duration_s=duration_s,
            ),
            session_id=None,
        )


@dataclass
class SimPlayer:
    """A virtual media element emitting the same telemetry a real player must send."""

    browser: SimBrowser
    video_id: str
    duration_s: float = 600.0
    heartbeat_ms: float = 1_000.0
    media_s: float = 0.0
    rate: float = 1.0
    playing: bool = False
    _seg_n: int = 0
    _seg: str | None = None
    _anchor_browser: float = 0.0
    _anchor_media: float = 0.0
    _seq: int = 0
    _hb_token: int = 0

    def position(self) -> float:
        if not self.playing:
            return self.media_s
        return min(
            self.duration_s,
            self._anchor_media + (self.browser.now() - self._anchor_browser) / 1000 * self.rate,
        )

    def _emit(self, event: p.PlaybackEvent, state: p.PlaybackStateName) -> None:
        self._seq += 1
        self.browser.send(
            "playback_state",
            p.PlaybackState(
                video_id=self.video_id,
                segment_id=self._seg if state == "playing" else None,
                event=event,
                state=state,
                t_browser_ms=self.browser.now(),
                media_time_s=self.position(),
                playback_rate=self.rate,
                media_duration_s=self.duration_s,
                telemetry_seq=self._seq,
            ),
        )

    def _start_segment(self) -> None:
        self._seg_n += 1
        self._seg = f"{self.video_id}-seg-{self._seg_n}"
        self._anchor_browser = self.browser.now()
        self._anchor_media = self.media_s
        self.playing = True
        self._emit("playing", "playing")
        self._hb_token += 1
        self._schedule_heartbeat(self._hb_token)

    def _schedule_heartbeat(self, token: int) -> None:
        sim = self.browser.sim

        def beat() -> None:
            if self.playing and token == self._hb_token:
                self._emit("heartbeat", "playing")
                self._schedule_heartbeat(token)

        sim.scheduler.at(sim.clock.now_ms() + self.heartbeat_ms, beat)

    def _stop(self, event: p.PlaybackEvent, state: p.PlaybackStateName) -> None:
        self.media_s = self.position()
        self.playing = False
        self._hb_token += 1
        self._emit(event, state)

    def play(self) -> None:
        self._start_segment()

    def pause(self) -> None:
        self._stop("pause", "paused")

    def buffer(self) -> None:
        self._stop("waiting", "buffering")

    def seek(self, media_s: float, *, resume: bool = True) -> None:
        self._stop("seeking", "seeking")
        self.media_s = media_s
        if resume:
            self._start_segment()

    def set_rate(self, rate: float) -> None:
        was_playing = self.playing
        if was_playing:
            self.media_s = self.position()
            self.playing = False
        self.rate = rate
        if was_playing:
            self._start_segment()
        else:
            self._emit("ratechange", "paused")


class Sim:
    """One hub, any number of simulated browsers, deterministic time."""

    def __init__(
        self,
        hub_factory: Callable[[ManualClock], Hub],
        *,
        seed: int = 7,
        start_ms: float = 10_000.0,
        base_delay_ms: float = 2.0,
        jitter_ms: float = 3.0,
    ) -> None:
        self.clock = ManualClock(start_ms)
        self.rng = random.Random(seed)
        self.net = Network(self.rng, base_delay_ms, jitter_ms)
        self.scheduler = Scheduler(self.clock)
        self.hub = hub_factory(self.clock)
        self.browsers: list[SimBrowser] = []

    def browser(self, client_id: str = "client-1", *, offset_ms: float = 123_456.7) -> SimBrowser:
        b = SimBrowser(self, offset_ms, client_id)
        self.browsers.append(b)
        return b

    def run(self, ms: float) -> None:
        self.scheduler.run_until(self.clock.now_ms() + ms, self.hub)

    def restart_hub(self, hub_factory: Callable[[ManualClock], Hub]) -> None:
        """Simulate a backend restart: sockets drop, then a brand-new Hub (new instance id, no sessions)."""
        for b in self.browsers:
            if b.conn is not None:
                b.conn.close(1006, "backend process exited")
        self.hub = hub_factory(self.clock)
