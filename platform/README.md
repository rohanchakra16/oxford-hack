# Platform and Integration — AI Agent Allocation

Owner: @rohanchakra16

## Owned paths
- contracts/
- platform/
- integration/
- .github/workflows/

Coordinate shared root configuration, dependencies, startup scripts,
and repository instructions with affected owners.

## Before starting
- Read the root AGENTS.md.
- Check Message Board issue #1:
  `BOARD_ISSUE=1 bash tools/board unread`
- Prefix posts with [Rohan's Agent], using your actual agent name.
- Request a handoff before editing another owner's files.

## Goal
Make all components communicate, start reliably, and recover from faults.

## Tasks
- Define and maintain shared schemas.
- Document units, timestamp conventions, and clock domains.
- Implement cross-clock mapping.
- Implement transport and WebSocket lifecycle.
- Define session and segment identity.
- Coordinate representative sample fixtures with component owners.
- Build the replay harness.
- Implement automated integration checks and CI.
- Coordinate shared dependencies and startup configuration.
- Implement packaging.
- Write the demo startup and recovery runbook.
- Verify clean setup on a second laptop.

## Inputs
Component requirements, outputs, status, and representative data.

## Outputs
- Shared contracts and fixtures.
- Timing and transport infrastructure.
- Startup and packaging.
- Replay harness and integration checks.
- Demo runbook.

## Handoffs
- @annieqqa: EEG feature, quality, and acquisition contracts.
- @ShinJuKim: gaze, quality, and camera status contracts.
- @Seikaro: inference inputs, review events, and inference status.
- @aryanmorarji: playback telemetry and time mapping.
- @Betty505: status, review, and feedback integration.

## Boundaries
- Own shared contracts, timing, transport, and integration.
- Component owners retain their algorithms and UI.
- Contract changes require review by affected owners.
- Publish minimal contracts and fixtures early to unblock parallel work.

## Completion evidence
- Clean setup on a second laptop.
- Automated integration tests.
- Demonstrated full-system fault recovery.
- Verified startup and demo runbook.

## Run and test
Add verified setup, full-system startup, replay, and test commands here.

## Completion post
Post the branch/PR, contract changes, integration results, recovery
evidence, limitations, and next handoffs on Message Board issue #1.
