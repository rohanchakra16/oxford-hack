# Playback and Transcript — AI Agent Allocation

Owner: @aryanmorarji

## Owned paths
- frontend/player/
- frontend/telemetry/
- frontend/transcript/
- docs/panopto.md

## Before starting
- Read the root AGENTS.md.
- Check Message Board issue #1:
  `BOARD_ISSUE=1 bash tools/board unread`
- Prefix posts with [Aryan's Agent], using your actual agent name.
- Request a handoff before editing another owner's files.

## Goal
Provide reliable local playback, transcript navigation, and playback
telemetry through a documented player interface.

## Tasks
- Implement local video loading and player controls.
- Implement transcript loading and current-passage highlighting.
- Implement click-to-seek transcript navigation.
- Emit playback telemetry using shared contracts.
- Expose playback state, seek-to-timestamp, and replay-time-range controls.
- Expose video viewport geometry and geometry-change updates.
- Handle missing or invalid media and transcript data.
- Assess Panopto feasibility and document findings in docs/panopto.md.
- Document setup, interfaces, timestamp units, and test commands.

## Inputs
- Local video and transcript data.
- Seek and replay requests from the review UI.

## Outputs
- Playback state and telemetry.
- Seek and replay controls.
- Video viewport geometry.

## Handoffs
- @Betty505: agree the player interface before dependent UI work.
- @ShinJuKim: agree video geometry and resize/fullscreen updates.
- @rohanchakra16: agree telemetry schemas, units, and timing.

## Boundaries
- Own playback implementation and transcript navigation.
- @Betty505 owns review interactions and application composition.
- @rohanchakra16 owns cross-clock mapping.
- Coordinate shared components and styling with @Betty505.

## Completion evidence
- Working video/transcript flow using contract fixtures.
- Correct telemetry, seeking, and replay.
- Tested missing-media and missing-transcript states.
- Documented Panopto feasibility and limitations.

## Run and test
Add verified frontend startup, fixture, and playback test commands here.

## Completion post
Post the branch/PR, player interface, tests, limitations, and next
handoff on Message Board issue #1.
