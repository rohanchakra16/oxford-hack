# Initial validation report — 2026-11-07

This file records the initial synthetic milestone. The subsequent real public
EEG workload experiment, held-out metrics and transfer limitations are documented
in [EEGMAT.md](EEGMAT.md) and `fixtures/eegmat-report.json`.

Model `experimental-rule-baseline` 0.1.0, config `synthetic-0.1.0`.
Scope: synthetic software behaviour only. Evaluated live modes: none.

The reproducible smoke report is `fixtures/synthetic-report.json`, generated
with `python -m evaluation.synthetic`. Each mode produces one scripted event,
matched to its deliberately prescribed synthetic interval, with no duplicate
prediction; unknown startup and paused/interrupted status are observed.
The resulting perfect fixture scores are plumbing checks, not estimates of
attention accuracy or generalisation. No participant split has been scored.

All 30 tests passed. Run `python -m pytest src/inference/tests src/evaluation/tests -q` from the root with
the environment described in both READMEs. Tests cover all three modes,
quality/clock/missing-feature gating, stale input, repeated polls, playback
epoch boundaries, invalid/head-direction gaze, combined agreement, model
validation, local-label output boundaries, participant/session leakage,
deterministic splitting, duplicate predictions, and one-to-one event matching.

The initial validation environment is Windows, Python 3.13.18, Pydantic 2.12.5,
pytest 9.0.2 and Ruff 0.14.4. No training has occurred. Seed 17 is reserved for
the deterministic participant split; the scripted event demo is nonrandom.
The JSON report includes the bundle SHA-256 over canonical JSON (sorted keys,
compact separators, UTF-8), independent of checkout line endings.

Limitations: no live hardware input, participant recordings, independent
behavioural labels, trained weights, uncertainty estimates, or held-out metrics.
See `PROTOCOL.md` for the collection, splitting and scoring requirements before
any live mode can be called evaluated. Platform wiring and a wire-level
inference-status contract remain handoffs to @rohanchakra16.
