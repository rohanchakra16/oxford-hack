"""Supported ChatGPT plan OAuth for the local demo. Tokens remain in backend memory.

Registration/client mappings and the opaque host ID persist; restarting the backend
requires sign-in again. We never borrow Codex credentials or use ChatGPT backend APIs.
See https://developers.openai.com/siwc/token-sharing-open-source/sign-in.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any
from uuid import uuid4

from .question_errors import ErrorCode, IncompleteOutput, QuestionGenerationError

AUTH = "https://auth.openai.com"
RESOURCE = "https://api.openai.com/v1"
TOKEN_URL = f"{AUTH}/api/accounts/oauth/token"
SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
PLAN_SCOPE = "chatgpt.tokens.use.direct"
JsonHttp = Callable[[str, str, dict[str, str], bytes | None], dict[str, Any]]
TokenValidator = Callable[[str, str, str | None], dict[str, Any]]


def json_http(method: str, url: str, headers: dict[str, str], body: bytes | None) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(
            urllib.request.Request(url, body, headers, method=method), timeout=25
        ) as r:
            result = json.loads(r.read())
        if not isinstance(result, dict):
            raise ValueError("not an object")
        return result
    except urllib.error.HTTPError as error:
        code: ErrorCode = "rate_limited" if error.code == 429 else "not_connected"
        raise QuestionGenerationError(
            code, "ChatGPT could not complete the request. Reconnect or try later."
        ) from error
    except (ValueError, OSError) as error:
        raise QuestionGenerationError(
            "provider_error", "Cannot reach the ChatGPT connection service."
        ) from error


def validate_id_token(token: str, audience: str, nonce: str | None) -> dict[str, Any]:
    import jwt

    try:
        discovery = json_http("GET", f"{AUTH}/.well-known/openid-configuration", {}, None)
        uri = discovery["jwks_uri"]
        if (
            discovery.get("issuer") != AUTH
            or urllib.parse.urlparse(uri).scheme != "https"
            or (urllib.parse.urlparse(uri).netloc != "auth.openai.com")
        ):
            raise ValueError("unexpected issuer or keys endpoint")
        key = jwt.PyJWKClient(uri, timeout=15).get_signing_key_from_jwt(token).key
        claims: dict[str, Any] = jwt.decode(
            token,
            key,
            algorithms=["RS256"],
            audience=audience,
            issuer=AUTH,
            options={"require": ["exp", "iat", "sub", "aud", "iss"]},
        )
        if nonce is not None and not hmac.compare_digest(str(claims.get("nonce", "")), nonce):
            raise ValueError("nonce mismatch")
        return claims
    except Exception as error:
        # JWT/network libraries can include the offending token in their error. Never relay it.
        raise QuestionGenerationError(
            "not_connected", "ChatGPT identity verification failed. Sign in again."
        ) from error


class ChatGPTConnection:
    def __init__(
        self,
        state_path: Path,
        *,
        http: JsonHttp = json_http,
        validator: TokenValidator = validate_id_token,
        clock: Callable[[], float] = time.time,
    ):
        self.path, self.http, self.validator, self.clock = (
            state_path,
            http,
            validator,
            clock,
        )
        self._lock = threading.RLock()
        self._sessions: dict[str, dict[str, Any]] = {}
        self._pending: dict[str, Any] | None = None
        self._server: HTTPServer | None = None
        self._error: str | None = None
        self._registrations: dict[str, dict[str, str]] = {}
        self._host_id = f"urn:uuid:{uuid4()}"
        if self.path.exists():
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
                if not isinstance(data["hostId"], str) or not isinstance(data.get("accounts", {}), dict):
                    raise ValueError("invalid registration metadata")
                self._host_id = data["hostId"]
                self._registrations = data.get("accounts", {})
            except (OSError, ValueError, KeyError, TypeError):
                self._error = "Saved ChatGPT registration could not be read. Connect again."

    def _save_registration(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump({"hostId": self._host_id, "accounts": self._registrations}, stream)
        temporary.replace(self.path)

    def status(self) -> dict[str, Any]:
        with self._lock:
            pending = self._pending is not None and self.clock() < self._pending["expires"]
            return {
                "pending": pending,
                "error": self._error,
                "accounts": [
                    {
                        "id": key,
                        "label": value["label"],
                        "connected": key in self._sessions,
                        "planEnabled": PLAN_SCOPE in self._sessions.get(key, {}).get("scopes", []),
                    }
                    for key, value in self._registrations.items()
                ],
            }

    def begin(self, account_id: str | None = None) -> str:
        with self._lock:
            if self._pending is not None and self.clock() < self._pending["expires"]:
                raise QuestionGenerationError("provider_error", "A ChatGPT sign-in is already in progress.")
            registration = self._registrations.get(account_id or "")
            if account_id and registration is None:
                raise QuestionGenerationError(
                    "not_connected", "Choose an existing ChatGPT account or add one."
                )
            self._save_registration()  # persist host identity BEFORE the first authorization
            connection = self

            class Callback(BaseHTTPRequestHandler):
                def log_message(self, format: str, *args: Any) -> None:
                    pass  # callback query contains a short-lived authorization code

                def do_GET(self) -> None:
                    if self.headers.get("host") != f"127.0.0.1:{server.server_port}":
                        self.send_error(403)
                        return
                    parsed = urllib.parse.urlparse(self.path)
                    if parsed.path != "/auth/callback":
                        self.send_error(404)
                        return
                    params = {key: values[0] for key, values in urllib.parse.parse_qs(parsed.query).items()}
                    try:
                        connection.complete(params)
                        message = "ChatGPT connection saved. You can close this tab and return to ReMind."
                        status = 200
                    except QuestionGenerationError as error:
                        message, status = error.message, 400
                    self.send_response(status)
                    self.send_header("Content-Type", "text/plain; charset=utf-8")
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Referrer-Policy", "no-referrer")
                    self.end_headers()
                    self.wfile.write(message.encode())

            server = HTTPServer(("127.0.0.1", 0), Callback)
            server.timeout = 1
            redirect = f"http://127.0.0.1:{server.server_port}/auth/callback"
            verifier, state, nonce = (
                secrets.token_urlsafe(48),
                secrets.token_urlsafe(32),
                secrets.token_urlsafe(32),
            )
            self._pending = {
                "verifier": verifier,
                "state": state,
                "nonce": nonce,
                "redirect": redirect,
                "accountId": account_id,
                "clientId": registration["clientId"] if registration else None,
                "expires": self.clock() + 300,
            }
            self._error, self._server = None, server
            params = {
                "client_id": registration["clientId"] if registration else "dynamic_agent_client",
                "ext_agent_host_id": self._host_id,
                "response_type": "code",
                "redirect_uri": redirect,
                "scope": SCOPES,
                "resource": RESOURCE,
                "state": state,
                "nonce": nonce,
                "code_challenge_method": "S256",
                "code_challenge": base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
                .decode()
                .rstrip("="),
            }
            if registration is None:
                params["agent_name_hint"] = "ReMind lecture review"
            else:
                params["login_hint"] = registration.get("email", "")

            def listen() -> None:
                try:
                    while (
                        connection._server is server
                        and connection._pending is not None
                        and (connection.clock() < connection._pending["expires"])
                    ):
                        server.handle_request()
                finally:
                    server.server_close()
                    with connection._lock:
                        if connection._server is server:
                            if connection._pending is not None:
                                connection._error = "ChatGPT sign-in timed out. Try again."
                            connection._pending = None
                            connection._server = None

            threading.Thread(target=listen, name="remind-chatgpt-sign-in", daemon=True).start()
            return f"{AUTH}/api/accounts/authorize?{urllib.parse.urlencode(params)}"

    def complete(self, params: dict[str, str]) -> None:
        with self._lock:
            pending = self._pending
            if (
                pending is None
                or self.clock() >= pending["expires"]
                or not hmac.compare_digest(params.get("state", ""), pending["state"])
            ):
                raise QuestionGenerationError("not_connected", "Invalid or expired ChatGPT sign-in state.")
            self._pending = None  # valid state consumes this attempt even if exchange fails
            try:
                if params.get("error"):
                    raise QuestionGenerationError(
                        "not_connected", "ChatGPT sign-in was cancelled or declined."
                    )
                client_id = params.get("client_id") or pending["clientId"]
                if (
                    not client_id
                    or client_id == "dynamic_agent_client"
                    or (pending["clientId"] and client_id != pending["clientId"])
                    or not params.get("code")
                ):
                    raise QuestionGenerationError("not_connected", "ChatGPT registration was incomplete.")
                form = {
                    "grant_type": "authorization_code",
                    "client_id": client_id,
                    "code": params["code"],
                    "code_verifier": pending["verifier"],
                    "redirect_uri": pending["redirect"],
                    "resource": RESOURCE,
                }
                tokens = self.http(
                    "POST",
                    TOKEN_URL,
                    {"Content-Type": "application/x-www-form-urlencoded"},
                    urllib.parse.urlencode(form).encode(),
                )
                claims = self.validator(str(tokens.get("id_token", "")), client_id, pending["nonce"])
                old = self._registrations.get(pending["accountId"] or "")
                if old and claims["sub"] != old["subject"]:
                    raise QuestionGenerationError(
                        "not_connected",
                        "The ChatGPT account did not match this connection.",
                    )
                key = hashlib.sha256(f"{client_id}:{claims['sub']}".encode()).hexdigest()[:24]
                email = str(claims.get("email", ""))
                self._registrations[key] = {
                    "clientId": client_id,
                    "subject": claims["sub"],
                    "email": email,
                    "label": f"{email or 'ChatGPT account'} ({client_id[-6:]})",
                }
                self._install_tokens(key, tokens)
                self._save_registration()
            except QuestionGenerationError as error:
                self._error = error.message
                raise
            except (ValueError, KeyError, TypeError, OSError) as error:
                self._error = "ChatGPT returned an unusable connection. Try again."
                raise QuestionGenerationError("not_connected", self._error) from error

    def _install_tokens(self, key: str, tokens: dict[str, Any]) -> None:
        if not isinstance(tokens.get("access_token"), str) or not tokens["access_token"]:
            raise QuestionGenerationError("not_connected", "ChatGPT did not return an access token.")
        self._sessions[key] = {
            **tokens,
            "scopes": str(tokens.get("scope", "")).split(),
            "expiresAt": self.clock() + float(tokens.get("expires_in", 3600)),
        }

    def access_token(self, key: str) -> str:
        with self._lock:
            session = self._sessions.get(key)
            if session is None:
                raise QuestionGenerationError("not_connected", "Connect your ChatGPT account first.")
            if PLAN_SCOPE not in session["scopes"]:
                raise QuestionGenerationError(
                    "plan_not_enabled", "Allow ChatGPT plan usage when reconnecting."
                )
            if self.clock() >= session["expiresAt"] - 60:
                registration = self._registrations[key]
                if not session.get("refresh_token"):
                    raise QuestionGenerationError(
                        "not_connected", "Your ChatGPT connection expired. Reconnect."
                    )
                tokens = self.http(
                    "POST",
                    TOKEN_URL,
                    {"Content-Type": "application/x-www-form-urlencoded"},
                    urllib.parse.urlencode(
                        {
                            "grant_type": "refresh_token",
                            "client_id": registration["clientId"],
                            "refresh_token": session["refresh_token"],
                            "resource": RESOURCE,
                        }
                    ).encode(),
                )
                if tokens.get("id_token"):
                    claims = self.validator(tokens["id_token"], registration["clientId"], None)
                    if claims["sub"] != registration["subject"]:
                        raise QuestionGenerationError("not_connected", "ChatGPT identity changed. Reconnect.")
                merged = {**session, **tokens}
                self._install_tokens(key, merged)
                session = self._sessions[key]
                if PLAN_SCOPE not in session["scopes"]:
                    raise QuestionGenerationError(
                        "plan_not_enabled",
                        "ChatGPT plan access was removed. Reconnect.",
                    )
            return str(session["access_token"])

    def models(self, key: str) -> list[dict[str, str]]:
        body = self.http(
            "GET",
            f"{RESOURCE}/models",
            {"Authorization": f"Bearer {self.access_token(key)}"},
            None,
        )
        return [
            {"id": str(model["slug"]), "label": str(model.get("display_name") or model["slug"])}
            for model in body.get("models", [])
            if isinstance(model, dict)
            and model.get("visibility") == "list"
            and isinstance(model.get("slug"), str)
        ]

    def disconnect(self, key: str) -> bool:
        with self._lock:
            session = self._sessions.pop(key, None)
            if not session or not session.get("refresh_token"):
                return True
            try:
                discovery = self.http("GET", f"{AUTH}/.well-known/openid-configuration", {}, None)
                endpoint = str(discovery.get("revocation_endpoint", ""))
                if urllib.parse.urlparse(endpoint).netloc != "auth.openai.com" or not endpoint.startswith(
                    "https://"
                ):
                    return False
                request = urllib.request.Request(
                    endpoint,
                    urllib.parse.urlencode(
                        {
                            "token": session["refresh_token"],
                            "token_type_hint": "refresh_token",
                            "client_id": self._registrations[key]["clientId"],
                        }
                    ).encode(),
                    {"Content-Type": "application/x-www-form-urlencoded"},
                    method="POST",
                )
                with urllib.request.urlopen(request, timeout=15) as response:
                    return bool(response.status == 200)
            except (QuestionGenerationError, OSError):
                return False


def chatgpt_transport(connection: ChatGPTConnection, account_id: str) -> Callable[..., Any]:
    """Adapt JSON-schema question calls to the supported streaming Responses contract."""

    def send(url: str, headers: Any, raw: bytes, timeout: float) -> tuple[int, dict[str, str], bytes]:
        source = json.loads(raw)
        body = {
            "model": source["model"],
            "store": False,
            "stream": True,
            "instructions": source["messages"][0]["content"],
            "input": [{"role": "user", "content": source["messages"][1]["content"]}],
            "text": {
                "format": {
                    "type": "json_schema",
                    **source["response_format"]["json_schema"],
                }
            },
        }
        request = urllib.request.Request(
            f"{RESOURCE}/responses",
            json.dumps(body).encode(),
            {
                "Authorization": f"Bearer {connection.access_token(account_id)}",
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                text: list[str] = []
                completed = False
                for line in response:
                    if not line.startswith(b"data:"):
                        continue
                    content = line[5:].strip()
                    if content == b"[DONE]":
                        continue
                    event = json.loads(content)
                    kind = event.get("type")
                    if kind == "response.output_text.delta":
                        text.append(str(event.get("delta", "")))
                    elif kind in ("response.failed", "error"):
                        error = event.get("response", {}).get("error") or event.get("error") or {}
                        code = error.get("code", "") if isinstance(error, dict) else ""
                        if code in (
                            "subscription_sharing_usage_limit_exceeded",
                            "rate_limit_exceeded",
                        ):
                            raise QuestionGenerationError(
                                "rate_limited",
                                "ChatGPT plan limit reached. Manage usage in ChatGPT.",
                            )
                        raise QuestionGenerationError(
                            "provider_error",
                            "ChatGPT could not finish this response. Try again.",
                        )
                    elif kind == "response.incomplete":
                        raise IncompleteOutput()
                    elif kind == "response.completed":
                        completed = True
                if not completed:
                    raise IncompleteOutput()
            return (
                200,
                {},
                json.dumps(
                    {
                        "model": source["model"],
                        "choices": [{"message": {"content": "".join(text)}}],
                    }
                ).encode(),
            )
        except urllib.error.HTTPError as error:
            if error.code in (401, 403):
                raise QuestionGenerationError(
                    "not_connected",
                    "ChatGPT connection is no longer available. Reconnect.",
                ) from error
            return error.code, dict(error.headers or {}), b"{}"
        except TimeoutError as error:
            raise QuestionGenerationError("timeout", "ChatGPT took too long to respond.") from error
        except (OSError, ValueError) as error:
            raise QuestionGenerationError("provider_error", "Cannot read the ChatGPT response.") from error

    return send
