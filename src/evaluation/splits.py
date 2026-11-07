"""Deterministic participant-disjoint splits, checked at all nested group levels."""

import random
from collections import defaultdict
from dataclasses import dataclass


@dataclass(frozen=True)
class Recording:
    participant_id: str
    session_id: str
    recording_id: str

    def __post_init__(self):
        if not all((self.participant_id, self.session_id, self.recording_id)):
            raise ValueError("participant, session and recording IDs must be nonempty")


def validate_splits(splits: dict[str, list[Recording]]) -> None:
    if set(splits) != {"train", "validation", "test"} or any(not v for v in splits.values()):
        raise ValueError("nonempty train, validation and test splits are required")
    owners: dict[tuple[str, str], str] = {}
    recordings = set()
    for split, rows in splits.items():
        for row in rows:
            if row.recording_id in recordings:
                raise ValueError("duplicate recording")
            recordings.add(row.recording_id)
            for field in ("participant_id", "session_id", "recording_id"):
                key = (field, getattr(row, field))
                if key in owners and owners[key] != split:
                    raise ValueError(f"{field} crosses split boundary")
                owners[key] = split


def participant_splits(rows: list[Recording], seed: int = 17) -> dict[str, list[Recording]]:
    groups = defaultdict(list)
    for row in rows:
        groups[row.participant_id].append(row)
    participants = sorted(groups)
    if len(participants) < 3:
        raise ValueError("at least three participants required for disjoint train/validation/test")
    random.Random(seed).shuffle(participants)
    n_test = max(1, len(participants) // 5)
    n_val = max(1, len(participants) // 5)
    assignments = {
        "test": participants[:n_test],
        "validation": participants[n_test : n_test + n_val],
        "train": participants[n_test + n_val :],
    }
    splits = {
        name: sorted((r for p in people for r in groups[p]), key=lambda r: r.recording_id)
        for name, people in assignments.items()
    }
    validate_splits(splits)
    return splits
