from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from oxford_hack.contracts import MESSAGES, ContractError, parse_message

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "contracts" / "fixtures"


@pytest.mark.parametrize("path", sorted((FIXTURES / "valid").glob("*.json")), ids=lambda p: p.stem)
def test_valid_fixture_parses(path: Path) -> None:
    msg = parse_message(path.read_text())
    assert msg.type == path.stem


def test_every_message_type_has_a_valid_fixture() -> None:
    assert {p.stem for p in (FIXTURES / "valid").glob("*.json")} == set(MESSAGES)


@pytest.mark.parametrize("path", sorted((FIXTURES / "invalid").glob("*.json")), ids=lambda p: p.stem)
def test_invalid_fixture_rejected_with_expected_code(path: Path) -> None:
    case = json.loads(path.read_text())
    with pytest.raises(ContractError) as exc:
        parse_message(case["raw"])
    assert exc.value.code == case["expectedCode"]


@pytest.mark.parametrize("token", ["NaN", "Infinity", "-Infinity"])
def test_non_finite_numbers_rejected(token: str) -> None:
    raw = (
        (FIXTURES / "valid" / "playback_state.json")
        .read_text()
        .replace('"mediaTimeS": 42.0', f'"mediaTimeS": {token}')
    )
    with pytest.raises(ContractError) as exc:
        parse_message(raw)
    assert exc.value.code == "invalid_json"


def test_duplicate_keys_rejected() -> None:
    with pytest.raises(ContractError, match="duplicate key"):
        parse_message('{"schemaVersion":"0.1.0","schemaVersion":"0.1.0"}')


def test_error_messages_do_not_echo_values() -> None:
    obj = json.loads((FIXTURES / "valid" / "eeg_features.json").read_text())
    obj["payload"]["features"][0]["value"] = "SECRET-SIGNAL-123"
    with pytest.raises(ContractError) as exc:
        parse_message(json.dumps(obj))
    assert "SECRET-SIGNAL-123" not in exc.value.message


def test_unexpected_direction_rejected() -> None:
    raw = (FIXTURES / "valid" / "review_bookmark.json").read_text()
    with pytest.raises(ContractError) as exc:
        parse_message(raw, allowed_types=frozenset({"playback_state"}))
    assert exc.value.code == "unexpected_type"


def test_oversized_message_rejected() -> None:
    with pytest.raises(ContractError) as exc:
        parse_message("x" * (256 * 1024 + 1))
    assert exc.value.code == "message_too_large"


@pytest.mark.parametrize("script", ["generate_contracts.py", "make_fixtures.py"])
def test_generated_files_up_to_date(script: str) -> None:
    result = subprocess.run(
        [sys.executable, str(ROOT / "platform" / "scripts" / script), "--check"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
