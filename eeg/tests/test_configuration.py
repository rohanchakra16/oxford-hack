from pathlib import Path

import pytest

from eeg.utils.configuration import ConfigurationError, load_config


CONFIG_PATH = Path(__file__).parents[1] / "config.yaml"


def test_load_config_returns_validated_values() -> None:
    config = load_config(CONFIG_PATH)

    assert config["project"]["name"] == "unicorn_attention"
    assert config["acquisition"]["channel_count"] == 8


def test_load_config_raises_for_missing_file(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="Configuration file not found"):
        load_config(tmp_path / "missing.yaml")


def test_load_config_raises_for_invalid_values(tmp_path: Path) -> None:
    invalid_config = tmp_path / "invalid.yaml"
    invalid_config.write_text(
        """
project:
  name: unicorn_attention
  version: "0.1.0"
logging:
  level: INFO
acquisition:
  sample_rate_hz: 0
  channel_count: 8
""",
        encoding="utf-8",
    )

    with pytest.raises(ConfigurationError, match="sample_rate_hz"):
        load_config(invalid_config)
