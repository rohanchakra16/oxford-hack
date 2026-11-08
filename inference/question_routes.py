"""Authenticated, local-only question/context routes and explicit provider selection."""

from __future__ import annotations

import asyncio
import hmac
import threading
import time
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import Field, model_validator

from .chatgpt_connection import ChatGPTConnection, chatgpt_transport
from .lecture_context import ContextError, LectureContextInput, LectureContextStore
from .question_errors import QuestionGenerationError
from .question_generation import (
    PROMPT_VERSION,
    OpenRouterQuestionGenerator,
    QuestionInput,
    _Camel,
)


class ProviderSelection(_Camel):
    provider: Literal["openrouter", "chatgpt"] = "openrouter"
    account_id: str | None = Field(default=None, max_length=64)
    model: str | None = Field(default=None, max_length=256)


class ContextInput(LectureContextInput):
    selection: ProviderSelection = Field(default_factory=ProviderSelection)


class ContextQuestionInput(QuestionInput):
    selection: ProviderSelection = Field(default_factory=ProviderSelection)
    context_id: str | None = Field(default=None, min_length=64, max_length=64)
    target_start_media_s: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    target_end_media_s: float | None = Field(default=None, ge=0, allow_inf_nan=False)

    @model_validator(mode="after")
    def ordered(self) -> ContextQuestionInput:
        if self.end_media_s < self.start_media_s or (
            self.target_start_media_s is not None
            and self.target_end_media_s is not None
            and self.target_end_media_s < self.target_start_media_s
        ):
            raise ValueError("Invalid passage interval")
        return self


class AccountInput(_Camel):
    account_id: str | None = Field(default=None, max_length=64)


class ProviderRegistry:
    def __init__(
        self, default: OpenRouterQuestionGenerator, connection: ChatGPTConnection
    ):
        self.default, self.connection = default, connection
        self._lock = threading.Lock()
        self._generators: dict[str, OpenRouterQuestionGenerator] = {
            "openrouter": default
        }
        self._contexts: dict[str, LectureContextStore] = {
            "openrouter": LectureContextStore(default)
        }
        self._catalogs: dict[str, tuple[float, list[dict[str, str]]]] = {}

    def models(self, account_id: str) -> list[dict[str, str]]:
        with self._lock:
            hit = self._catalogs.get(account_id)
            if hit and time.monotonic() - hit[0] < 60:
                return hit[1]
        models = self.connection.models(account_id)
        with self._lock:
            self._catalogs[account_id] = (time.monotonic(), models)
        return models

    def resolve(
        self, selection: ProviderSelection
    ) -> tuple[OpenRouterQuestionGenerator, LectureContextStore]:
        key = "openrouter"
        if selection.provider == "chatgpt":
            if not selection.account_id:
                raise QuestionGenerationError(
                    "not_connected", "Connect and select your ChatGPT account."
                )
            self.connection.access_token(
                selection.account_id
            )  # permission check even for cached results
            choices = self.models(selection.account_id)
            model = selection.model
            if model is None or model not in {m["id"] for m in choices}:
                raise QuestionGenerationError(
                    "not_configured",
                    "Choose a model available to this ChatGPT account.",
                )
            key = f"chatgpt:{selection.account_id}:{model}"
            with self._lock:
                if key not in self._generators:
                    # The bearer token is supplied exclusively by the transport at request time.
                    gen = OpenRouterQuestionGenerator(
                        api_key="oauth-managed",
                        model=model,
                        timeout_s=60,
                        transport=chatgpt_transport(
                            self.connection, selection.account_id
                        ),
                    )
                    self._generators[key] = gen
                    self._contexts[key] = LectureContextStore(gen)
        with self._lock:
            return self._generators[key], self._contexts[key]

    def forget_account(self, account_id: str) -> None:
        with self._lock:
            self._catalogs.pop(account_id, None)
            for key in list(self._generators):
                if key.startswith(f"chatgpt:{account_id}:"):
                    self._generators.pop(key)
                    self._contexts.pop(key)


def error_response(error: QuestionGenerationError) -> JSONResponse:
    status = {
        "not_configured": 503,
        "rate_limited": 429,
        "timeout": 504,
        "provider_error": 502,
        "invalid_output": 502,
        "not_connected": 401,
        "plan_not_enabled": 403,
        "context_expired": 409,
    }[error.code]
    headers = (
        {"Retry-After": str(int(error.retry_after_s + 0.999))}
        if error.retry_after_s is not None
        else {}
    )
    return JSONResponse(
        {
            "error": error.code,
            "message": error.message,
            "retryAfterS": error.retry_after_s,
        },
        status,
        headers,
    )


def register_routes(
    app: FastAPI,
    *,
    launch_token: str,
    allowed_origins: list[str],
    generator: OpenRouterQuestionGenerator | None = None,
    connection: ChatGPTConnection | None = None,
) -> OpenRouterQuestionGenerator:
    gen = generator or OpenRouterQuestionGenerator()
    chatgpt = connection or ChatGPTConnection(
        Path(__file__).resolve().parents[1] / ".local/chatgpt/registrations.json"
    )
    registry = ProviderRegistry(gen, chatgpt)

    def denied(request: Request) -> JSONResponse | None:
        if request.headers.get("origin") not in allowed_origins:
            return JSONResponse({"error": "origin_rejected"}, 403)
        if not hmac.compare_digest(
            request.headers.get("x-launch-token", "").encode(), launch_token.encode()
        ):
            return JSONResponse({"error": "not_authenticated"}, 401)
        return None

    @app.get("/api/v0/questions/status")
    async def status(request: Request) -> JSONResponse:
        if (error := denied(request)) is not None:
            return error
        return JSONResponse(
            {
                "configured": gen.configured,
                "model": gen.model,
                "promptVersion": PROMPT_VERSION,
                "chatgpt": chatgpt.status(),
            }
        )

    @app.post("/api/v0/questions/chatgpt/connect")
    async def connect(request: Request, body: AccountInput) -> JSONResponse:
        if (error := denied(request)) is not None:
            return error
        try:
            url = await asyncio.to_thread(chatgpt.begin, body.account_id)
            return JSONResponse({"authorizationUrl": url})
        except QuestionGenerationError as exception:
            return error_response(exception)

    @app.post("/api/v0/questions/chatgpt/disconnect")
    async def disconnect(request: Request, body: AccountInput) -> JSONResponse:
        if (error := denied(request)) is not None:
            return error
        if not body.account_id:
            return JSONResponse({"error": "account_required"}, 422)
        revoked = await asyncio.to_thread(chatgpt.disconnect, body.account_id)
        registry.forget_account(body.account_id)
        return JSONResponse({"disconnected": True, "revocationConfirmed": revoked})

    @app.get("/api/v0/questions/chatgpt/models")
    async def models(request: Request, accountId: str) -> JSONResponse:
        if (error := denied(request)) is not None:
            return error
        try:
            return JSONResponse(
                {"models": await asyncio.to_thread(registry.models, accountId)}
            )
        except QuestionGenerationError as exception:
            return error_response(exception)

    @app.post("/api/v0/questions/context")
    async def prepare_context(request: Request, body: ContextInput) -> JSONResponse:
        if (error := denied(request)) is not None:
            return error
        try:
            _, contexts = await asyncio.to_thread(registry.resolve, body.selection)
            context = await asyncio.to_thread(contexts.prepare, body)
            return JSONResponse(
                {"contextId": context.context_id, "blockCount": len(context.blocks)}
            )
        except ContextError as exception:
            return error_response(
                QuestionGenerationError("invalid_output", str(exception))
            )
        except QuestionGenerationError as exception:
            return error_response(exception)

    @app.post("/api/v0/questions")
    async def question(request: Request, body: ContextQuestionInput) -> JSONResponse:
        if (error := denied(request)) is not None:
            return error
        try:
            selected, contexts = await asyncio.to_thread(
                registry.resolve, body.selection
            )
            context: dict[str, Any] | None = None
            if body.context_id:
                lecture = contexts.get(body.context_id, body.video_id)
                if lecture is None:
                    raise QuestionGenerationError(
                        "context_expired", "Prepare lecture context again."
                    )
                start = (
                    body.target_start_media_s
                    if body.target_start_media_s is not None
                    else body.start_media_s
                )
                end = (
                    body.target_end_media_s
                    if body.target_end_media_s is not None
                    else body.end_media_s
                )
                context = lecture.for_target(start, end)
                if not context["target_passage"]:
                    return JSONResponse({"status": "insufficient_context"})
            result = await asyncio.to_thread(selected.generate, body.text, context)
            out = result.model_dump(mode="json", by_alias=True)
            out.update(
                bookmarkId=body.bookmark_id,
                videoId=body.video_id,
                provider=body.selection.provider,
            )
            return JSONResponse(out)
        except QuestionGenerationError as exception:
            return error_response(exception)

    return gen
