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
Add verified calibration, model-loading, inference, and test commands here.

## Completion post
Post the branch/PR, changes, tests, model version, limitations,
and next handoff on Message Board issue #1.
