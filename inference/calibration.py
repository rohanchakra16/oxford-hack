"""Local participant calibration of declared model scores, never raw EEG."""

import hashlib
import json
import math
import os
import statistics
import time
from pathlib import Path

DEFAULT_CALIBRATION_DIR = Path(__file__).resolve().parents[1] / ".local" / "calibration"


class CalibrationMemory:
    def __init__(self, root=None):
        self.root = Path(
            root or os.environ.get("REMIND_CALIBRATION_DIR") or DEFAULT_CALIBRATION_DIR
        )

    def path(self, participant, signature):
        key = hashlib.sha256(
            json.dumps([participant, signature], sort_keys=True).encode()
        ).hexdigest()
        return self.root / f"{key}.json"

    def load(self, participant, signature):
        try:
            data = json.loads(self.path(participant, signature).read_text())
            profile = data["history"][-1]
            if data["version"] != 1 or data["signature"] != signature:
                return None
            age = time.time() - profile["created"]
            if not math.isfinite(age) or not 0 <= age <= 90 * 86400:
                return None
            if not all(
                math.isfinite(profile[k])
                for k in ("mean", "std", "p10", "p90", "low", "recovery", "veryLow")
            ):
                return None
            if (
                not 0
                <= profile["veryLow"]
                < profile["low"]
                < profile["recovery"]
                <= 100
            ):
                return None
            return profile
        except (OSError, ValueError, KeyError, IndexError, TypeError):
            return None

    def save(self, participant, signature, profile):
        path = self.path(participant, signature)
        history = []
        try:
            history = json.loads(path.read_text())["history"][-4:]
        except (OSError, ValueError, KeyError, TypeError):
            pass
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(
                {"version": 1, "signature": signature, "history": [*history, profile]}
            )
        )
        temporary.replace(path)

    def reset(self, participant, signature):
        self.path(participant, signature).unlink(missing_ok=True)


def calibration_statistics(values):
    if len(values) < 30 or any(
        not math.isfinite(v) or not 0 <= v <= 100 for v in values
    ):
        raise ValueError("Thirty finite model scores required")
    ordered = sorted(values)
    mean, std = statistics.mean(values), statistics.pstdev(values)
    p10, p90 = (
        ordered[int((len(values) - 1) * 0.1)],
        ordered[int((len(values) - 1) * 0.9)],
    )
    if std > 20 or p90 - p10 > 50:
        raise ValueError("Baseline is unstable; focus normally and try again")
    spread = max(5, std)
    low = max(5, min(80, mean - 2 * spread, p10 - spread))
    return {
        "mean": mean,
        "std": std,
        "p10": p10,
        "p90": p90,
        "low": low,
        "veryLow": max(0, low - spread),
        "recovery": min(95, low + max(5, 0.75 * spread)),
        "created": time.time(),
        "count": len(values),
    }
