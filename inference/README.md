# Inference — AI Agent Allocation

Owner: @Seikaro
Owned folders: inference/, evaluation/

## Before starting
- Read the root AGENTS.md and evaluation/README.md.
- Check Message Board issue #1:
  `BOARD_ISSUE=1 bash tools/board unread`
- Prefix posts with [Seikaro's Agent], using your actual agent name.
- Request a handoff before editing another owner's files.

## Goal
Interpret aligned EEG, gaze, and playback context to produce
review events with explicit unknown and interrupted states.

## Tasks
- Define calibration and label-collection protocols.
- Implement label-collection tooling.
- Implement a versioned model bundle and configuration.
- Support EEG-only, gaze-only, and combined modes.
- Implement event logic and state transitions.
- Handle poor-quality, missing, unknown, and interrupted input.
- Provide representative review-event fixtures.
- Document model loading, configuration, and inference commands.

## Inputs
- EEG features and quality from @annieqqa.
- Gaze measurements and quality from @ShinJuKim.
- Playback context and aligned timing through shared contracts.

## Outputs
- Review events.
- Inference status.
- Versioned model bundle and configuration.

## Handoffs
- @annieqqa: agree EEG feature definitions and requirements.
- @ShinJuKim: agree gaze measurements and quality requirements.
- @rohanchakra16: agree timing, input contracts, and event schemas.
- @Betty505: agree event fields and unknown/interrupted presentation.

## Boundaries
- Own interpretation and event decisions.
- Sensor owners retain acquisition and feature/measurement production.
- @Betty505 owns review-event presentation.
- @rohanchakra16 owns shared timing and transport.
- Do not duplicate inference logic in frontend code.

## Completion evidence
- EEG-only, gaze-only, and combined modes work.
- Unknown and interruption behaviour is tested.
- Models and configurations are versioned.
- Held-out evaluation evidence is documented in evaluation/.

## Run and test
Initial implementation: `adapter.BaselineInference` implements the platform
`InferenceAdapter` without editing platform code. `model.load_bundle()` loads
the strict, versioned `bundles/baseline-0.1.0.json`. It is synthetic-only and
declares no evaluated modes. `adapter.inference_factory` returns no detector
for live/replay sessions; the platform owner must wire the factory for demos.

From the repository root, using Python 3.11–3.13:

```powershell
python -m venv inference/.venv
inference/.venv/Scripts/python.exe -m pip install pydantic==2.12.5 pytest==9.0.2 ruff==0.14.4
$env:PYTHONPATH = "$PWD;$PWD/platform/src"
inference/.venv/Scripts/python.exe -m inference.demo --mode both
inference/.venv/Scripts/python.exe -m inference.demo --mode eeg_only
inference/.venv/Scripts/python.exe -m inference.demo --mode gaze_only
inference/.venv/Scripts/python.exe -m pytest inference/tests evaluation/tests -q
inference/.venv/Scripts/ruff.exe check --config platform/pyproject.toml inference evaluation
```

On POSIX, use `.venv/bin/python` and
`export PYTHONPATH="$PWD:$PWD/platform/src"` instead. No OpenAI API or learned
model dependency is used. Calibration and label collection are documented in
`evaluation/PROTOCOL.md`; `python -m evaluation.labels --help` describes entry.

The rule uses 4 s complete EEG/gaze evidence, 2 s sustained advancing evidence,
15 s cooldown, quality and clock gates, and resets on playback eligibility
changes. EEG requires an exact feature version/name/unit/channel match; the
current scalar is a **synthetic placeholder**, pending @annieqqa's definition.
Gaze uses duration-weighted outside-video fraction of valid calibrated screen
gaze, not confidence or head direction. Combined mode requires both thresholds.
Scores remain separate per signal and are not attention probabilities.
Candidates carry the union of evidence used for dwell and all contributing
input IDs. The hub alone maps that evidence to media timestamps.

`adapter.status` exposes local `unknown`, `interrupted`, `ready`, `pending`,
`cooldown`, and `closed` diagnostics. Unknown/interrupted never create review
candidates. These diagnostics are not yet a shared wire message; transport/UI
requires agreement with @rohanchakra16 and @Betty505. Representative candidates
and status traces for all three modes are in `fixtures/review-events.json`.

This is the first issue #5 milestone. Real sensor configurations, live wiring,
training and participant-held-out evaluation remain pending; do not enable
automatic suggestions from these synthetic results.

## Completion post
Post the branch/PR, changes, tests, model version, limitations,
and next handoff on Message Board issue #1.
