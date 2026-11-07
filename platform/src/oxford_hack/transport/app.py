"""Local HTTP + WebSocket transport. Owner: Person 5.

Security model (docs/SECURITY.md):
* Binds to loopback only (enforced in cli.py) and rejects non-loopback Host headers
  (defeats DNS rebinding).
* Browser origins must be on an explicit allowlist, for both the handshake and the WebSocket.
* A per-install *launch token* (never embedded in frontend code) is handed to the browser via
  the pairing URL fragment. POST /api/v0/handshake exchanges it for a short-lived, single-use
  *session token* bound to the page's clientInstanceId; the WebSocket's first message must
  present that token.
* Test hooks exist only when the server is started with ``--enable-test-hooks``.
"""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import logging
import secrets
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from typing import Any

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel
from starlette.types import ASGIApp, Receive, Scope, Send

from ..contracts import SCHEMA_VERSION, ContractError, dumps, envelope, parse_message, validate_message
from ..contracts import payloads as p
from ..contracts.messages import BACKEND_INTERNAL, EnvelopeBase
from ..session.hub import Hub, Priority
from ..timing.clock import Clock, MonotonicClock

log = logging.getLogger("oxford_hack.transport")

LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "[::1]", "::1"})


@dataclass
class ServerConfig:
    launch_token: str
    allowed_origins: list[str] = field(
        default_factory=lambda: ["http://localhost:5173", "http://127.0.0.1:5173"]
    )
    test_hooks: bool = False
    session_token_ttl_ms: float = 120_000.0
    hello_timeout_s: float = 5.0
    tick_interval_s: float = 0.05
    max_outbound_queue: int = 512


class _Camel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        validate_by_name=True,
        validate_by_alias=True,
        serialize_by_alias=True,
        extra="forbid",
    )


class HandshakeRequest(_Camel):
    launch_token: str = Field(min_length=1, max_length=256)
    client_instance_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$")


class HandshakeResponse(_Camel):
    session_token: str
    backend_instance_id: str
    schema_version: str
    expires_in_ms: float
    ws_path: str


class InjectRequest(_Camel):
    session_id: str
    message: dict[str, Any]


class LoopbackHostMiddleware:
    """Reject requests whose Host is not loopback (DNS-rebinding protection)."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] in ("http", "websocket"):
            host = ""
            for k, v in scope.get("headers", []):
                if k == b"host":
                    host = v.decode("latin-1")
                    break
            name = host.rsplit(":", 1)[0] if not host.startswith("[") else host.split("]")[0] + "]"
            if name not in LOOPBACK_HOSTS:
                if scope["type"] == "http":
                    resp = JSONResponse({"error": "host_rejected"}, status_code=421)
                    await resp(scope, receive, send)
                else:
                    await send({"type": "websocket.close", "code": 4403, "reason": "host rejected"})
                return
        await self.app(scope, receive, send)


class WsConnection:
    """Hub-facing side of one WebSocket, with a bounded outbound queue."""

    def __init__(self, connection_id: str, websocket: WebSocket, maxsize: int) -> None:
        self.connection_id = connection_id
        self._ws = websocket
        self._queue: asyncio.Queue[str | None] = asyncio.Queue(maxsize=maxsize)
        self.closed: tuple[int, str] | None = None
        self.dropped_status = 0

    def send(self, message: EnvelopeBase, priority: Priority) -> None:
        if self.closed:
            return
        try:
            self._queue.put_nowait(dumps(message))
        except asyncio.QueueFull:
            if priority == "status":
                self.dropped_status += 1
                return
            # Never silently lose data: close, and let the client resume (it gets a snapshot).
            self.close(4408, "backpressure: reconnect and resume")

    def close(self, code: int, reason: str) -> None:
        if self.closed:
            return
        self.closed = (code, reason)
        with contextlib.suppress(asyncio.QueueFull):
            self._queue.put_nowait(None)
        if self._queue.full():
            # Queue full of data: drop it, the client will resume from a snapshot.
            while not self._queue.empty():
                self._queue.get_nowait()
            self._queue.put_nowait(None)

    async def writer(self) -> None:
        while True:
            item = await self._queue.get()
            if item is None:
                code, reason = self.closed or (1000, "closed")
                with contextlib.suppress(Exception):
                    await self._ws.close(code=code, reason=reason)
                return
            await self._ws.send_text(item)


def _origin_allowed(origin: str | None, config: ServerConfig) -> bool:
    return origin is not None and origin in config.allowed_origins


def create_app(
    config: ServerConfig,
    hub_factory: Callable[[Clock], Hub],
    *,
    clock: Clock | None = None,
) -> FastAPI:
    clock = clock or MonotonicClock()
    tokens: dict[str, tuple[str, float]] = {}  # session token -> (clientInstanceId, expiry backend ms)

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        hub = hub_factory(clock)
        app.state.hub = hub

        async def ticker() -> None:
            while True:
                hub.tick()
                await asyncio.sleep(config.tick_interval_s)

        task = asyncio.create_task(ticker())
        if config.test_hooks:
            log.warning(
                "TEST HOOKS ENABLED: /api/v0/test/* is available. Never use this mode with real data."
            )
        try:
            yield
        finally:
            task.cancel()
            hub.shutdown()

    app = FastAPI(
        title="oxford-hack local backend",
        version=SCHEMA_VERSION,
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.allowed_origins,
        allow_methods=["GET", "POST"],
        allow_headers=["content-type", "x-launch-token"],
        allow_credentials=False,
    )
    app.add_middleware(LoopbackHostMiddleware)

    def hub_of(app_: FastAPI) -> Hub:
        hub: Hub = app_.state.hub
        return hub

    @app.get("/api/v0/health")
    async def health(request: Request) -> dict[str, Any]:
        hub = hub_of(request.app)
        return {
            "status": "ok",
            "schemaVersion": SCHEMA_VERSION,
            "backendInstanceId": hub.backend_instance_id,
            "testHooks": config.test_hooks,
        }

    @app.post("/api/v0/handshake")
    async def handshake(request: Request, body: HandshakeRequest) -> JSONResponse:
        if not _origin_allowed(request.headers.get("origin"), config):
            return JSONResponse({"error": "origin_rejected", "message": "this origin is not allowed"}, 403)
        if not hmac.compare_digest(body.launch_token.encode(), config.launch_token.encode()):
            return JSONResponse(
                {
                    "error": "not_authenticated",
                    "message": "launch token not recognised; open the pairing link printed by the backend",
                },
                401,
            )
        now = clock.now_ms()
        for t, (_, exp) in list(tokens.items()):
            if exp < now:
                del tokens[t]
        token = secrets.token_urlsafe(32)
        tokens[token] = (body.client_instance_id, now + config.session_token_ttl_ms)
        hub = hub_of(request.app)
        return JSONResponse(
            HandshakeResponse(
                session_token=token,
                backend_instance_id=hub.backend_instance_id,
                schema_version=SCHEMA_VERSION,
                expires_in_ms=config.session_token_ttl_ms,
                ws_path="/ws/v0",
            ).model_dump(by_alias=True)
        )

    @app.websocket("/ws/v0")
    async def ws_endpoint(websocket: WebSocket) -> None:
        if not _origin_allowed(websocket.headers.get("origin"), config):
            await websocket.close(code=4403, reason="origin rejected")
            return
        await websocket.accept()
        hub = hub_of(websocket.app)
        conn = WsConnection(secrets.token_hex(6), websocket, config.max_outbound_queue)

        async def reject(code: p.ErrorCode, message: str, close_code: int) -> None:
            report = p.ErrorReport(code=code, message=message, ref_message_id=None, fatal=True, details={})
            msg = envelope("error", report, message_id=f"m-{secrets.token_hex(6)}", session_id=None, seq=0)
            with contextlib.suppress(Exception):
                await websocket.send_text(dumps(msg))
                await websocket.close(code=close_code, reason=code)

        try:
            first = await asyncio.wait_for(websocket.receive_text(), timeout=config.hello_timeout_s)
        except (TimeoutError, WebSocketDisconnect):
            with contextlib.suppress(Exception):
                await websocket.close(code=4401, reason="no client_hello")
            return
        try:
            hello_msg = parse_message(first, allowed_types=frozenset({"client_hello"}))
        except ContractError as err:
            await reject(err.code, err.message, 4400)
            return
        hello: p.ClientHello = hello_msg.payload  # type: ignore[assignment]
        entry = tokens.pop(hello.session_token, None)
        if entry is None or entry[1] < clock.now_ms() or entry[0] != hello.client_instance_id:
            await reject(
                "not_authenticated",
                "session token invalid, expired, already used, or issued to "
                "another client; repeat the handshake",
                4401,
            )
            return

        writer = asyncio.create_task(conn.writer())
        hub.attach(conn, hello)
        try:
            while conn.closed is None:
                text = await websocket.receive_text()
                hub.receive(conn, text)
        except WebSocketDisconnect:
            pass
        except Exception:  # pragma: no cover - defensive: never leak signal data into logs
            log.exception("websocket loop failed (connection %s)", conn.connection_id)
        finally:
            hub.detach(conn)
            conn.close(1000, "closed")
            with contextlib.suppress(Exception):
                await asyncio.wait_for(writer, timeout=1.0)

    if config.test_hooks:

        def check_hook(request: Request) -> JSONResponse | None:
            token = request.headers.get("x-launch-token", "")
            if not hmac.compare_digest(token.encode(), config.launch_token.encode()):
                return JSONResponse({"error": "not_authenticated"}, 401)
            return None

        @app.get("/api/v0/test/state")
        async def test_state(request: Request) -> JSONResponse:
            if (denied := check_hook(request)) is not None:
                return denied
            hub = hub_of(request.app)
            return JSONResponse(
                {
                    "nowBackendMs": clock.now_ms(),
                    "backendInstanceId": hub.backend_instance_id,
                    "sessions": [
                        {
                            "sessionId": s.id,
                            "videoId": s.config.video_id,
                            "runKind": s.config.run_kind,
                            "connected": s.conn is not None,
                            "bookmarks": len(s.bookmarks),
                            "segments": [seg.segment_id for seg in s.timeline.segments],
                            "counters": dict(s.counters),
                        }
                        for s in hub.sessions.values()
                    ],
                    "endedSessions": list(hub.ended_sessions),
                }
            )

        @app.post("/api/v0/test/inject")
        async def test_inject(request: Request, body: InjectRequest) -> JSONResponse:
            """Inject a backend-internal message (eeg_features, eeg_status, review_candidate) into a session,
            through the same contract validation as real adapters."""
            if (denied := check_hook(request)) is not None:
                return denied
            try:
                msg = validate_message(body.message, allowed_types=BACKEND_INTERNAL)
            except ContractError as err:
                return JSONResponse({"accepted": False, "code": err.code, "message": err.message}, 400)
            hub_of(request.app).ingest_internal(msg.payload, session_id=body.session_id)  # type: ignore[arg-type]
            return JSONResponse({"accepted": True})

    return app
