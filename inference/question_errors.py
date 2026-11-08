"""Safe, user-facing errors shared by question providers and sign-in."""

from typing import Literal

ErrorCode = Literal[
    "not_configured",
    "rate_limited",
    "timeout",
    "provider_error",
    "invalid_output",
    "not_connected",
    "plan_not_enabled",
    "context_expired",
]


class QuestionGenerationError(Exception):
    def __init__(
        self, code: ErrorCode, message: str, retry_after_s: float | None = None
    ):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retry_after_s = retry_after_s


class IncompleteOutput(QuestionGenerationError):
    def __init__(self) -> None:
        super().__init__(
            "invalid_output",
            "The model could not return a complete answer within the limit.",
        )
