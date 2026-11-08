"""Fake, timestamped attention-score stream.

The module deliberately has no hardware or g.Pype dependency.  It provides
the data contract that a real attention estimator can implement later.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import sin, tau
from typing import Iterator

DEFAULT_THRESHOLD = 0.5


@dataclass(frozen=True)
class AttentionSample:
    """One attention observation.

    ``timestamp`` is elapsed time in seconds from the beginning of a stream.
    ``score`` is always standardised to the inclusive interval [0, 1].
    ``paying_attention`` is derived from ``score >= threshold``.
    """

    timestamp: float
    score: float
    paying_attention: bool


def _validate_threshold(threshold: float) -> float:
    if not 0.0 <= threshold <= 1.0:
        raise ValueError("threshold must be between 0 and 1 inclusive")
    return float(threshold)


def standardise_score(score: float) -> float:
    """Clamp a raw attention value to the public [0, 1] scale."""

    return max(0.0, min(1.0, float(score)))


def classify_attention(score: float, threshold: float = DEFAULT_THRESHOLD) -> bool:
    """Return whether a standardised score meets the attention threshold."""

    threshold = _validate_threshold(threshold)
    return standardise_score(score) >= threshold


class FakeAttentionStream:
    """Generate deterministic, timestamped attention observations.

    Args:
        sampling_rate_hz: Number of observations generated per second.
        threshold: Constant threshold used for classification.
        phase: Optional phase offset for deterministic test scenarios.
    """

    def __init__(
        self,
        sampling_rate_hz: float = 10.0,
        threshold: float = DEFAULT_THRESHOLD,
        phase: float = 0.0,
    ) -> None:
        if sampling_rate_hz <= 0:
            raise ValueError("sampling_rate_hz must be positive")
        self.sampling_rate_hz = float(sampling_rate_hz)
        self.threshold = _validate_threshold(threshold)
        self.phase = float(phase)

    def stream(self, count: int) -> Iterator[AttentionSample]:
        """Yield exactly ``count`` fake observations from time zero."""

        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise ValueError("count must be a non-negative integer")

        for index in range(count):
            timestamp = index / self.sampling_rate_hz
            raw_score = 0.5 + 0.45 * sin(tau * 0.2 * timestamp + self.phase)
            score = standardise_score(raw_score)
            yield AttentionSample(
                timestamp=timestamp,
                score=score,
                paying_attention=score >= self.threshold,
            )

