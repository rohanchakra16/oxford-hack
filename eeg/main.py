"""Application entry point for the Unicorn EEG attention project."""

from pathlib import Path

from eeg.utils.configuration import load_config
from eeg.utils.logging_config import configure_logging


def main() -> None:
    """Load project configuration and initialise application logging."""
    project_root = Path(__file__).resolve().parent
    config = load_config(project_root / "config.yaml")
    configure_logging(config)


if __name__ == "__main__":
    main()
