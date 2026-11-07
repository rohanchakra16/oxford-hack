# Evaluation — AI Agent Allocation

Owner: @Seikaro
Related component: inference/

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
Add verified training, validation, and held-out evaluation commands here.

## Data handling
Keep credentials and participant recordings out of Git.
Document how authorised teammates can access required data.

## Completion post
Post the report location, model version, evaluation commands,
results, and limitations on Message Board issue #1.
