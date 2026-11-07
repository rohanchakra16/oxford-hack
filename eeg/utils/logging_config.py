"""Application logging setup."""

import logging
from typing import Any


def configure_logging(config: dict[str, Any]) -> None:
    """Configure the root logger using the validated application config."""
    level_name = config["logging"]["level"].upper()
    logging.basicConfig(
        level=getattr(logging, level_name),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
