# Attention stream interface

`attention_stream.py` defines the interface used by the fake attention
producer.  A future EEG/ML implementation can replace `FakeAttentionStream`
while preserving the emitted `AttentionSample` contract.

## Specification

- `FakeAttentionStream.stream(count)` yields exactly `count` samples.
- Each sample has:
  - `timestamp`: elapsed seconds from stream start, beginning at `0.0` and
    increasing by `1 / sampling_rate_hz`.
  - `score`: a floating-point attention score in the inclusive range `[0, 1]`.
  - `paying_attention`: `True` when `score >= threshold`, otherwise `False`.
- `threshold` is constant for the lifetime of a stream and must be in
  `[0, 1]`. The default is `0.5`.
- `standardise_score(value)` clamps raw values to `[0, 1]`.
- `classify_attention(score, threshold)` applies the same inclusive threshold
  rule independently of the fake generator.
- The fake generator is deterministic for a given `phase`, sampling rate, and
  count. It does not access hardware or sleep between samples.

Run the tests from the repository root with:

```bash
pytest gpype_stream/test_attention_stream.py
```
