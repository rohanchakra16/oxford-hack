"""Loading and validation for the application configuration."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml


class ConfigurationError(ValueError):
    """Raised when the application configuration is missing or invalid."""


def validate_config(config: Any) -> dict[str, Any]:
    """Validate and return the application configuration.

    The initial schema deliberately covers only values needed by the scaffold.
    """
    if not isinstance(config, dict):
        raise ConfigurationError("Configuration must contain a YAML mapping.")

    for section in ("project", "logging", "acquisition"):
        if not isinstance(config.get(section), dict):
            raise ConfigurationError(f"Configuration section '{section}' is required.")

    project = config["project"]
    if not isinstance(project.get("name"), str) or not project["name"].strip():
        raise ConfigurationError("project.name must be a non-empty string.")
    if not isinstance(project.get("version"), str) or not project["version"].strip():
        raise ConfigurationError("project.version must be a non-empty string.")

    logging = config["logging"]
    if not isinstance(logging.get("level"), str) or not logging["level"].strip():
        raise ConfigurationError("logging.level must be a non-empty string.")
    if logging["level"].upper() not in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}:
        raise ConfigurationError(
            "logging.level must be one of DEBUG, INFO, WARNING, ERROR, or CRITICAL."
        )

    acquisition = config["acquisition"]
    for key in ("sample_rate_hz", "channel_count"):
        value = acquisition.get(key)
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise ConfigurationError(f"acquisition.{key} must be a positive integer.")

    return config


def load_config(path: str | Path) -> dict[str, Any]:
    """Load, validate, and return a YAML configuration file."""
    config_path = Path(path)
    if not config_path.is_file():
        raise FileNotFoundError(f"Configuration file not found: {config_path}")

    with config_path.open("r", encoding="utf-8") as config_file:
        config = yaml.safe_load(config_file)

    return validate_config(config)
