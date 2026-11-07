# Evaluation — AI Agent Allocation

Owner: @Seikaro
Related component: inference/

Lecture prototype: [inference/LECTURE_PROTOTYPE.md](../inference/LECTURE_PROTOTYPE.md).
Run `python -m evaluation.lecture_replay --suite` for reproducible event/prompt
counts across normal, educational immediate, and educational end-of-lecture
behaviours. Fixtures/report: `fixtures/lecture-*.json`. Attention accuracy and
false-positive rates are explicitly unreported until suitable labels exist.

Real-time EEG evaluation: [REALTIME.md](REALTIME.md). Run
`python -m evaluation.realtime_stream --mock --duration-s 8 --warmup-s 0`
for continuous 500 ms updates through Annie's actual streaming pipeline.
The evaluator measures timing/quality, supports owner-provided live pipelines
and independent labels, and keeps stub/workload outputs explicitly unknown.

Public-data experiment: [EEGMAT.md](EEGMAT.md), with machine-readable results in
`fixtures/eegmat-report.json`. A real arithmetic-versus-rest EEG model is trained
and evaluated on held-out participants; it is a workload proxy, not attention
ground truth. Local lecture-attention evaluation remains pending.

## Before starting
- Read the root AGENTS.md and inference/README.md.
- Check Message Board issue #1:
  `BOARD_ISSUE=1 bash tools/board unread`

## Goal
Produce reproducible, leakage-free evidence of inference performance.

## Tasks
- Document datasets, labels, and inclusion/exclusion criteria.
- Define train, validation, and test splits.
- Prevent leakage across participants, sessions, or recordings as
  appropriate to the evaluation question.
- Fit learned preprocessing and model parameters on training data only.
- Use validation data for tuning and keep test data held out.
- Evaluate EEG-only, gaze-only, and combined modes.
- Define event-matching rules and event-level metrics.
- Evaluate unknown and interruption behaviour.
- Record model versions, configurations, and random seeds.
- Produce an evaluation report with limitations.

## Inputs
Labelled recordings, model bundles, and inference outputs.

## Outputs
- Reproducible evaluation commands.
- Metrics and an evaluation report.
- Documented split definitions and limitations.

## Handoffs
- @annieqqa and @ShinJuKim: confirm recorded data and quality semantics.
- @rohanchakra16: coordinate replay fixtures and integration checks.
- @Betty505: explain event behaviour relevant to UI presentation.

## Completion evidence
- Reproducible held-out results.
- Documented leakage prevention.
- Event-level metrics.
- Tested unknown and interrupted input.
- Clear limitations and failure cases.

## Run and test
See `PROTOCOL.md` for calibration, independent labels, exclusion rules,
participant-disjoint splits and frozen event-matching rules. `REPORT.md`
documents the initial synthetic validation and its limitations.

Use the environment/setup in `inference/README.md`, then from the root:

```powershell
$env:PYTHONPATH = "$PWD;$PWD/platform/src"
inference/.venv/Scripts/python.exe -m evaluation.labels --help
inference/.venv/Scripts/python.exe -m evaluation.synthetic
inference/.venv/Scripts/python.exe -m pytest inference/tests evaluation/tests -q
```

Library entry points: `splits.participant_splits` / `validate_splits`,
`metrics.Event` / `event_metrics`, and `labels.Label` / `append_label`.
The label collector appends validated local JSONL only under ignored `data/`.
Public EEG download, training and recording-scoring commands are in `EEGMAT.md`.
No local attention-labelled recordings have been evaluated.
`evaluation.synthetic` checks scripted event plumbing only; its perfect fixture
scores are not accuracy.

## Data handling
Keep credentials and participant recordings out of Git.
Document how authorised teammates can access required data.

## Completion post
Post the report location, model version, evaluation commands,
results, and limitations on Message Board issue #1.
