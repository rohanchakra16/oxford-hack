"""FastAPI transport: security checks and the real WebSocket protocol (in-process TestClient)."""

from __future__ import annotations

import json
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from oxford_hack.contracts import SCHEMA_VERSION
from oxford_hack.harness.synthetic import simulation_factory
from oxford_hack.session.hub import Hub, IdFactory
from oxford_hack.transport.app import ServerConfig, create_app

TOKEN = "test-launch-token-0123456789"
ORIGIN = "http://127.0.0.1:5173"
WS = "ws://127.0.0.1:8765/ws/v0"


def make_client(*, test_hooks: bool = False, base_url: str = "http://127.0.0.1:8765") -> TestClient:
    config = ServerConfig(
        launch_token=TOKEN, allowed_origins=[ORIGIN], test_hooks=test_hooks, hello_timeout_s=1.0
    )
    app = create_app(
        config, lambda clock: Hub(clock, simulation_factory=simulation_factory(), ids=IdFactory("t"))
    )
    return TestClient(app, base_url=base_url)


@pytest.fixture
def client() -> Iterator[TestClient]:
    with make_client() as c:
        yield c


def handshake(c: TestClient, client_id: str = "client-1") -> str:
    r = c.post(
        "/api/v0/handshake",
        json={"launchToken": TOKEN, "clientInstanceId": client_id},
        headers={"origin": ORIGIN},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["schemaVersion"] == SCHEMA_VERSION
    return str(body["sessionToken"])


def msg(type_: str, payload: dict, seq: int, session_id: str | None = None) -> str:  # type: ignore[type-arg]
    return json.dumps(
        {
            "schemaVersion": SCHEMA_VERSION,
            "messageId": f"b-{seq}",
            "sessionId": session_id,
            "seq": seq,
            "type": type_,
            "payload": payload,
        }
    )


def hello(token: str, client_id: str = "client-1") -> str:
    return msg(
        "client_hello",
        {
            "clientInstanceId": client_id,
            "sessionToken": token,
            "resume": None,
            "capabilities": {"playbackTelemetry": True, "gaze": False, "diagnostics": True},
            "tBrowserMs": 10.0,
        },
        0,
    )


def receive_until(ws, type_: str, limit: int = 50) -> dict:  # type: ignore[no-untyped-def, type-arg]
    for _ in range(limit):
        m = json.loads(ws.receive_text())
        if m["type"] == type_:
            return m  # type: ignore[no-any-return]
    raise AssertionError(f"no {type_} received")


def test_health(client: TestClient) -> None:
    r = client.get("/api/v0/health")
    assert (
        r.status_code == 200
        and r.json()["schemaVersion"] == SCHEMA_VERSION
        and r.json()["testHooks"] is False
    )


def test_non_loopback_host_rejected() -> None:
    with make_client(base_url="http://attacker.example") as c:
        assert c.get("/api/v0/health").status_code == 421


@pytest.mark.parametrize("origin", [None, "http://evil.example", "http://127.0.0.1:9999"])
def test_handshake_rejects_unlisted_origins(client: TestClient, origin: str | None) -> None:
    headers = {"origin": origin} if origin else {}
    r = client.post(
        "/api/v0/handshake", json={"launchToken": TOKEN, "clientInstanceId": "c"}, headers=headers
    )
    assert r.status_code == 403


def test_handshake_rejects_wrong_launch_token(client: TestClient) -> None:
    r = client.post(
        "/api/v0/handshake",
        json={"launchToken": "wrong", "clientInstanceId": "c"},
        headers={"origin": ORIGIN},
    )
    assert r.status_code == 401 and r.json()["error"] == "not_authenticated"


def test_cors_only_for_allowed_origin(client: TestClient) -> None:
    pre = {"access-control-request-method": "POST", "access-control-request-headers": "content-type"}
    ok = client.options("/api/v0/handshake", headers={"origin": ORIGIN, **pre})
    bad = client.options("/api/v0/handshake", headers={"origin": "http://evil.example", **pre})
    assert ok.headers.get("access-control-allow-origin") == ORIGIN
    assert "access-control-allow-origin" not in bad.headers


def test_websocket_rejects_unlisted_origin(client: TestClient) -> None:
    with (
        pytest.raises(WebSocketDisconnect) as exc,
        client.websocket_connect(WS, headers={"origin": "http://evil.example"}),
    ):
        pass
    assert exc.value.code == 4403


def test_websocket_rejects_invalid_and_reused_session_tokens(client: TestClient) -> None:
    with client.websocket_connect(WS, headers={"origin": ORIGIN}) as ws:
        ws.send_text(hello("tok_not_a_real_token_000"))
        err = json.loads(ws.receive_text())
        assert err["payload"]["code"] == "not_authenticated" and err["payload"]["fatal"]
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_text()
        assert exc.value.code == 4401
    token = handshake(client)
    with client.websocket_connect(WS, headers={"origin": ORIGIN}) as ws:
        ws.send_text(hello(token))
        assert json.loads(ws.receive_text())["type"] == "server_hello"
    with client.websocket_connect(WS, headers={"origin": ORIGIN}) as ws:
        ws.send_text(hello(token))  # single use
        assert json.loads(ws.receive_text())["payload"]["code"] == "not_authenticated"


def test_token_bound_to_client_instance(client: TestClient) -> None:
    token = handshake(client, "client-A")
    with client.websocket_connect(WS, headers={"origin": ORIGIN}) as ws:
        ws.send_text(hello(token, "client-B"))
        assert json.loads(ws.receive_text())["payload"]["code"] == "not_authenticated"


def test_first_message_must_be_client_hello(client: TestClient) -> None:
    with client.websocket_connect(WS, headers={"origin": ORIGIN}) as ws:
        ws.send_text(msg("heartbeat", {"clock": "browser", "sentMs": 1.0}, 0))
        assert json.loads(ws.receive_text())["payload"]["code"] == "unexpected_type"


def test_session_flow_and_non_fatal_invalid_message(client: TestClient) -> None:
    token = handshake(client)
    with client.websocket_connect(WS, headers={"origin": ORIGIN}) as ws:
        ws.send_text(hello(token))
        server_hello = json.loads(ws.receive_text())
        assert server_hello["payload"]["resumeOutcome"] == "new"
        ws.send_text(
            msg(
                "session_start",
                {
                    "videoId": "video-1",
                    "runKind": "simulated",
                    "requestedSensors": {"eeg": True, "gaze": False},
                    "mediaDurationS": 300.0,
                },
                1,
            )
        )
        config = receive_until(ws, "session_config")
        assert config["payload"]["runKind"] == "simulated"
        ws.send_text('{"schemaVersion":"0.2.0","type":"playback_state","payload":{"mediaTimeS":NaN}}')
        err = receive_until(ws, "error")
        assert err["payload"]["code"] == "invalid_json" and err["payload"]["fatal"] is False
        ws.send_text(msg("session_end", {"reason": "user_ended"}, 2, config["sessionId"]))
        assert receive_until(ws, "session_ended")["payload"]["reason"] == "client_ended"


def test_live_run_kind_replay_is_refused(client: TestClient) -> None:
    token = handshake(client)
    with client.websocket_connect(WS, headers={"origin": ORIGIN}) as ws:
        ws.send_text(hello(token))
        ws.receive_text()
        ws.send_text(
            msg(
                "session_start",
                {
                    "videoId": "v",
                    "runKind": "replay",
                    "requestedSensors": {"eeg": False, "gaze": False},
                    "mediaDurationS": None,
                },
                1,
            )
        )
        assert "not accepted" in receive_until(ws, "error")["payload"]["message"]


def test_test_hooks_absent_by_default(client: TestClient) -> None:
    assert client.get("/api/v0/test/state", headers={"x-launch-token": TOKEN}).status_code == 404
    assert client.post("/api/v0/test/inject", json={}).status_code in (404, 405)


def test_test_hooks_require_launch_token_and_validate() -> None:
    with make_client(test_hooks=True) as c:
        assert c.get("/api/v0/health").json()["testHooks"] is True
        assert c.get("/api/v0/test/state").status_code == 401
        state = c.get("/api/v0/test/state", headers={"x-launch-token": TOKEN}).json()
        assert state["sessions"] == []
        bad = c.post(
            "/api/v0/test/inject",
            headers={"x-launch-token": TOKEN},
            json={"sessionId": "x", "message": {"schemaVersion": SCHEMA_VERSION, "type": "playback_state"}},
        )
        assert bad.status_code == 400 and bad.json()["code"] == "unexpected_type"


def test_websocket_rejects_non_loopback_host(client: TestClient) -> None:
    with (
        pytest.raises(WebSocketDisconnect) as exc,
        client.websocket_connect("ws://attacker.example/ws/v0", headers={"origin": ORIGIN}),
    ):
        pass
    assert exc.value.code == 4403
