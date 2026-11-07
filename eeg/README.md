# EEG Systems — AI Agent Allocation

Owner: @annieqqa
Owned folder: eeg/

## Before starting
- Read the root AGENTS.md.
- Check Message Board issue #1:
  `BOARD_ISSUE=1 bash tools/board unread`
- Identify yourself in posts as [Annie's Agent], replacing Agent with
  your actual agent name.
- Request a handoff before editing another owner's files.

## Goal
Produce reliable, timestamped EEG features and quality diagnostics
from live hardware and recorded input.

## Tasks
- Implement the real-device acquisition adapter.
- Implement a recorded-input adapter.
- Validate channel metadata, sampling rate, timestamps, and units.
- Implement causal preprocessing and feature extraction.
- Detect poor signal quality, missing samples, and interruptions.
- Stream features and quality using shared contracts.
- Add an optional raw logger if required.
- Document device setup, dependencies, and live/replay commands.

## Inputs
Device samples or recorded EEG, with timestamps and metadata.

## Outputs
- Timestamped EEG features.
- Quality diagnostics.
- Acquisition and connection status.

## Handoffs
- @Seikaro: agree feature definitions and inference requirements.
- @rohanchakra16: agree schemas, units, timestamps, and transport.
- @Betty505: provide acquisition status and setup guidance for the UI.

## Boundaries
- Own EEG acquisition and feature production.
- @Seikaro owns feature interpretation and review-event decisions.
- @rohanchakra16 owns cross-clock mapping.
- Coordinate shared contract changes before implementing them.

## Completion evidence
- A real-device recording.
- Tested gaps and reconnections.
- Matching live/replay features under equivalent configuration.
- Documented quality behaviour and limitations.

## Run and test
Add verified installation, live acquisition, replay, and test commands here.

## Completion post
Post the branch/PR, changes, tests, limitations, and next handoff
on Message Board issue #1.
