"""Synthetic OAuth and streaming tests; no account credentials or provider calls."""

import json
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import parse_qs, urlparse

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from inference.chatgpt_connection import (
    AUTH,
    PLAN_SCOPE,
    ChatGPTConnection,
    chatgpt_transport,
    validate_id_token,
)
from inference.question_errors import IncompleteOutput, QuestionGenerationError


class FakeService:
    def __init__(self):
        self.calls = []
        self.scopes = f"openid email {PLAN_SCOPE}"

    def __call__(self, method, url, headers, body):
        self.calls.append((url, parse_qs(body.decode()) if body else None))
        if url.endswith("/models"):
            return {
                "models": [
                    {
                        "slug": "visible-model",
                        "display_name": "Visible",
                        "visibility": "list",
                    },
                    {"slug": "hidden-model", "visibility": "hidden"},
                ]
            }
        return {
            "access_token": "synthetic-access",
            "refresh_token": "synthetic-refresh",
            "id_token": "synthetic-id",
            "scope": self.scopes,
            "expires_in": 3600,
        }


def connection(tmp_path, service=None, clock=None):
    service = service or FakeService()
    c = ChatGPTConnection(
        tmp_path / "registrations.json",
        http=service,
        validator=lambda token, client, nonce: {
            "sub": "synthetic-user",
            "email": "demo@example.test",
        },
        **({"clock": clock} if clock else {}),
    )
    return c, service


def sign_in(c):
    query = parse_qs(urlparse(c.begin()).query)
    c.complete(
        {
            "code": "synthetic-code",
            "state": query["state"][0],
            "client_id": "oaiapp_synthetic",
        }
    )
    return c.status()["accounts"][0]["id"], query


def test_dynamic_registration_pkce_and_no_persisted_tokens(tmp_path):
    c, service = connection(tmp_path)
    key, query = sign_in(c)
    assert query["client_id"] == ["dynamic_agent_client"]
    assert query["code_challenge_method"] == ["S256"]
    assert query["resource"] == ["https://api.openai.com/v1"]
    assert query["redirect_uri"][0].startswith("http://127.0.0.1:")
    assert query["redirect_uri"][0].endswith("/auth/callback")
    assert service.calls[0][1]["client_id"] == ["oaiapp_synthetic"]
    assert service.calls[0][1]["redirect_uri"] == query["redirect_uri"]
    assert c.access_token(key) == "synthetic-access"
    saved = c.path.read_text()
    assert (
        "synthetic-access" not in saved and "synthetic-refresh" not in saved and "synthetic-id" not in saved
    )
    restarted, _ = connection(tmp_path)
    assert restarted.status()["accounts"][0]["connected"] is False
    again = parse_qs(urlparse(restarted.begin(key)).query)
    assert again["client_id"] == ["oaiapp_synthetic"]
    assert again["ext_agent_host_id"] == query["ext_agent_host_id"]
    # End the synthetic callback listener without any network token exchange.
    with pytest.raises(QuestionGenerationError):
        restarted.complete({"error": "access_denied", "state": again["state"][0]})


@pytest.mark.parametrize(
    "params",
    [
        {"state": "wrong-state", "code": "code", "client_id": "oaiapp_test"},
        {"code": "code", "client_id": "dynamic_agent_client"},
        {"code": "code"},
        {"error": "access_denied"},
    ],
)
def test_rejects_invalid_or_declined_sign_in_without_token_exchange(tmp_path, params):
    c, service = connection(tmp_path)
    q = parse_qs(urlparse(c.begin()).query)
    with pytest.raises(QuestionGenerationError):
        c.complete({"state": q["state"][0], **params})
    assert service.calls == []
    assert not c.status()["accounts"]
    if c._pending:
        with pytest.raises(QuestionGenerationError):
            c.complete({"state": q["state"][0], "error": "access_denied"})


def test_plan_permission_is_required_and_models_are_account_specific(tmp_path):
    c, service = connection(tmp_path)
    service.scopes = "openid email"
    key, _ = sign_in(c)
    assert c.status()["accounts"][0]["planEnabled"] is False
    with pytest.raises(QuestionGenerationError) as error:
        c.access_token(key)
    assert error.value.code == "plan_not_enabled"
    c._sessions[key]["scopes"].append(PLAN_SCOPE)
    assert c.models(key) == [{"id": "visible-model", "label": "Visible"}]


def test_concurrent_refresh_is_serialized(tmp_path):
    now = [1000.0]
    c, service = connection(tmp_path, clock=lambda: now[0])
    key, _ = sign_in(c)
    now[0] += 3600
    with ThreadPoolExecutor(max_workers=4) as pool:
        assert list(pool.map(lambda _: c.access_token(key), range(4))) == ["synthetic-access"] * 4
    assert len(service.calls) == 2
    assert service.calls[-1][1]["client_id"] == ["oaiapp_synthetic"]
    assert service.calls[-1][1]["grant_type"] == ["refresh_token"]


def test_disconnect_clears_local_tokens_even_when_remote_revocation_cannot_be_confirmed(tmp_path):
    c, _ = connection(tmp_path)
    key, _ = sign_in(c)
    c.http = lambda *args: {"revocation_endpoint": "https://unexpected.invalid/revoke"}
    assert c.disconnect(key) is False
    assert c.status()["accounts"][0]["connected"] is False
    with pytest.raises(QuestionGenerationError):
        c.access_token(key)


def test_corrupt_registration_does_not_break_optional_question_service_startup(tmp_path):
    (tmp_path / "registrations.json").write_text("incomplete-json")
    c, _ = connection(tmp_path)
    assert c.status()["accounts"] == []
    assert "could not be read" in c.status()["error"]


def test_id_token_signature_audience_and_nonce_are_checked(monkeypatch):
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    claims = {
        "iss": AUTH,
        "aud": "oaiapp_test",
        "sub": "user",
        "iat": int(time.time()),
        "exp": int(time.time()) + 300,
        "nonce": "nonce",
    }
    token = jwt.encode(claims, private, algorithm="RS256", headers={"kid": "test-key"})
    monkeypatch.setattr(
        "inference.chatgpt_connection.json_http",
        lambda *args: {"issuer": AUTH, "jwks_uri": AUTH + "/jwks"},
    )

    class Keys:
        def __init__(self, *args, **kwargs):
            pass

        def get_signing_key_from_jwt(self, value):
            return type("Key", (), {"key": private.public_key()})()

    monkeypatch.setattr(jwt, "PyJWKClient", Keys)
    assert validate_id_token(token, "oaiapp_test", "nonce")["sub"] == "user"
    for audience, nonce in [
        ("another-client", "nonce"),
        ("oaiapp_test", "wrong-nonce"),
    ]:
        with pytest.raises(QuestionGenerationError):
            validate_id_token(token, audience, nonce)
    bad = jwt.encode({**claims, "exp": 1}, private, algorithm="RS256")
    with pytest.raises(QuestionGenerationError):
        validate_id_token(bad, "oaiapp_test", "nonce")


@pytest.mark.parametrize("terminal", ["response.completed", "response.incomplete", None, "response.failed"])
def test_stream_requires_completion_and_uses_supported_contract(tmp_path, monkeypatch, terminal):
    c, _ = connection(tmp_path)
    key, _ = sign_in(c)
    events = [{"type": "response.output_text.delta", "delta": '{"status":"ready"}'}]
    if terminal:
        events.append(
            {
                "type": terminal,
                "response": {"error": {"code": "subscription_sharing_usage_limit_exceeded"}},
            }
        )
    captured = []

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def __iter__(self):
            return iter([b"data: " + json.dumps(event).encode() + b"\n" for event in events])

    def open_request(request, **kwargs):
        captured.append(json.loads(request.data))
        return Response()

    monkeypatch.setattr("urllib.request.urlopen", open_request)
    source = {
        "model": "visible-model",
        "messages": [{"content": "Instructions"}, {"content": "Transcript"}],
        "response_format": {
            "json_schema": {
                "name": "test",
                "strict": True,
                "schema": {"type": "object"},
            }
        },
    }

    def call():
        return chatgpt_transport(c, key)("unused", {}, json.dumps(source).encode(), 5)

    if terminal == "response.completed":
        assert json.loads(call()[2])["choices"][0]["message"]["content"] == '{"status":"ready"}'
    elif terminal == "response.failed":
        with pytest.raises(QuestionGenerationError) as error:
            call()
        assert error.value.code == "rate_limited"
    else:
        with pytest.raises(IncompleteOutput):
            call()
    assert captured[0]["store"] is False and captured[0]["stream"] is True
    assert captured[0]["instructions"] == "Instructions"
    assert "temperature" not in captured[0] and "max_output_tokens" not in captured[0]
