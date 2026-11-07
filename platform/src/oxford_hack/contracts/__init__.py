"""Shared message contracts (PROPOSED v0.1.0). Source of truth: payloads.py and messages.py."""

from . import payloads
from .base import SCHEMA_VERSION
from .messages import (
    BACKEND_INTERNAL,
    BROWSER_TO_BACKEND,
    MESSAGES,
    AnyMessage,
    ContractError,
    dumps,
    envelope,
    parse_message,
    to_wire,
    validate_message,
)

__all__ = [
    "BACKEND_INTERNAL",
    "BROWSER_TO_BACKEND",
    "MESSAGES",
    "SCHEMA_VERSION",
    "AnyMessage",
    "ContractError",
    "dumps",
    "envelope",
    "parse_message",
    "payloads",
    "to_wire",
    "validate_message",
]
