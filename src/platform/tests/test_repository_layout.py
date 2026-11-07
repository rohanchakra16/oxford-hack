"""Relocating source must preserve repository-local state and label boundaries."""

from pathlib import Path

from oxford_hack.cli import DEFAULT_TOKEN_FILE, REPO_ROOT


def test_launch_token_stays_in_repository_local_directory() -> None:
    root = Path(__file__).resolve().parents[3]
    assert root == REPO_ROOT
    assert (root / "AGENTS.md").is_file()
    assert root / ".local" / "launch-token" == DEFAULT_TOKEN_FILE
