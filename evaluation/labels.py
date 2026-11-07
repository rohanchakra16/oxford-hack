"""Local JSONL label collector. Participant files belong in ignored data/ only."""

import argparse
from pathlib import Path
from typing import Literal

from oxford_hack.contracts.base import Contract, Id
from pydantic import Field, model_validator


class Label(Contract):
    protocol_version: Literal["0.1.0"] = "0.1.0"
    participant_id: Id
    session_id: Id
    recording_id: Id
    start_backend_ms: float = Field(ge=0)
    end_backend_ms: float = Field(gt=0)
    label: Literal["review", "no_review", "unknown", "interrupted"]
    source: Literal["self_report", "observer", "scripted"]

    @model_validator(mode="after")
    def interval(self) -> "Label":
        if self.end_backend_ms <= self.start_backend_ms:
            raise ValueError("label interval must have positive duration")
        return self


def append_label(path: Path, label: Label) -> None:
    """Restrict recording-derived labels to the repository's ignored data directory."""
    root = Path(__file__).resolve().parents[1] / "data"
    target = path.resolve()
    if not target.is_relative_to(root.resolve()) or target.suffix != ".jsonl":
        raise ValueError("labels must be .jsonl files under the repository data/ directory")
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("a", encoding="utf-8") as handle:
        handle.write(label.model_dump_json(by_alias=False) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--participant", required=True)
    parser.add_argument("--session", required=True)
    parser.add_argument("--recording", required=True)
    parser.add_argument("--start-ms", type=float, required=True)
    parser.add_argument("--end-ms", type=float, required=True)
    parser.add_argument("--label", choices=["review", "no_review", "unknown", "interrupted"], required=True)
    parser.add_argument("--source", choices=["self_report", "observer", "scripted"], required=True)
    args = parser.parse_args()
    label = Label(
        participant_id=args.participant,
        session_id=args.session,
        recording_id=args.recording,
        start_backend_ms=args.start_ms,
        end_backend_ms=args.end_ms,
        label=args.label,
        source=args.source,
    )
    append_label(args.output, label)
    print("Appended one local label (protocol 0.1.0).")


if __name__ == "__main__":
    main()
