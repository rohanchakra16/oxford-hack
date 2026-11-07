"""Export the JSON Schema bundle from the pydantic contract models.

Usage: uv run python scripts/generate_contracts.py [--check]
Writes contracts/schema/oxford-hack.schema.json. With --check, exits 1 if the file is out of date.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Literal

from pydantic import BaseModel
from pydantic.json_schema import models_json_schema

from oxford_hack.contracts import MESSAGES, SCHEMA_VERSION

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "contracts" / "schema" / "oxford-hack.schema.json"


def build() -> str:
    models: list[tuple[type[BaseModel], Literal["validation"]]] = [
        (spec.model, "validation") for spec in MESSAGES.values()
    ]
    refs, defs = models_json_schema(models, ref_template="#/$defs/{model}", by_alias=True)
    messages = {}
    for name, spec in MESSAGES.items():
        ref = refs[(spec.model, "validation")]["$ref"]
        messages[name] = {
            "$ref": ref,
            "channel": spec.channel,
            "sender": spec.sender,
            "receiver": spec.receiver,
            "owner": spec.owner,
        }
    bundle = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": f"https://oxford-hack.local/schema/{SCHEMA_VERSION}",
        "title": "oxford-hack shared message contracts",
        "description": (
            "PROPOSED - generated from backend/src/oxford_hack/contracts. Do not edit by hand. "
            "Structural rules only; cross-field rules are documented in descriptions "
            "and enforced by the backend."
        ),
        "x-schemaVersion": SCHEMA_VERSION,
        "x-messages": messages,
        "anyOf": [{"$ref": m["$ref"]} for m in messages.values()],
        "$defs": defs["$defs"],
    }
    return json.dumps(bundle, indent=2, sort_keys=True) + "\n"


def main() -> int:
    text = build()
    if "--check" in sys.argv:
        if not OUT.exists() or OUT.read_text() != text:
            print(
                f"{OUT.relative_to(ROOT)} is out of date: run `npm run contracts:generate`", file=sys.stderr
            )
            return 1
        print("schema up to date")
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text)
    print(f"wrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
