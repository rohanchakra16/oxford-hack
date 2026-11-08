from __future__ import annotations

import pytest

from gpype_stream.attention_stream import (
    DEFAULT_THRESHOLD,
    FakeAttentionStream,
    classify_attention,
    standardise_score,
)


def test_fake_stream_scores_are_standardised() -> None:
    samples = list(FakeAttentionStream().stream(100))

    assert samples
    assert all(0.0 <= sample.score <= 1.0 for sample in samples)
    assert all(
        later.timestamp > earlier.timestamp
        for earlier, later in zip(samples, samples[1:])
    )


def test_fake_stream_uses_expected_timestamps_and_threshold() -> None:
    stream = FakeAttentionStream(sampling_rate_hz=2, threshold=0.6)
    samples = list(stream.stream(3))

    assert [sample.timestamp for sample in samples] == [0.0, 0.5, 1.0]
    assert all(
        sample.paying_attention == (sample.score >= 0.6) for sample in samples
    )


def test_standardisation_and_classification() -> None:
    assert standardise_score(-0.2) == 0.0
    assert standardise_score(1.2) == 1.0
    assert classify_attention(0.5, DEFAULT_THRESHOLD) is True
    assert classify_attention(0.49, DEFAULT_THRESHOLD) is False


@pytest.mark.parametrize("threshold", [-0.01, 1.01])
def test_threshold_must_be_in_range(threshold: float) -> None:
    with pytest.raises(ValueError, match="between 0 and 1"):
        FakeAttentionStream(threshold=threshold)
