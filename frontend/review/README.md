# Review Experience and Onboarding — AI Agent Allocation

Owner: @Betty505

## Owned paths
- frontend/review/
- frontend/recovery/
- frontend/onboarding/
- frontend/components/
- frontend/styles/
- Frontend application composition: agree the entry-point path
  once the framework is established.

## Before starting
- Read the root AGENTS.md.
- Check Message Board issue #1:
  `BOARD_ISSUE=1 bash tools/board unread`
- Prefix posts with [Betty's Agent], using your actual agent name.
- Request a handoff before editing another owner's files.

## Goal
Provide an accessible review and recovery experience connected to
the player, inference events, and system status.

## Tasks
- Implement review-event display and the review timeline.
- Implement bookmarks.
- Request replay through @aryanmorarji's player interface.
- Implement dismiss and feedback interactions.
- Implement onboarding screens.
- Display device and session status supplied by the systems/platform.
- Own frontend application composition and shared UI styling.
- Implement keyboard-accessible interactions.
- Handle loading, empty, failure, and disconnected states.
- Develop against contract fixtures while dependencies are being built.
- Document interaction flows and test commands.

## Inputs
- Review events from @Seikaro.
- Player state and controls from @aryanmorarji.
- Device/session status from the relevant systems and platform.

## Outputs
- Replay requests.
- Dismissals and feedback using agreed contracts.
- Integrated review and onboarding UI.

## Handoffs
- @aryanmorarji: agree playback state, seeking, and time-range replay.
- @Seikaro: agree review-event fields and unknown/interrupted presentation.
- @rohanchakra16: agree status and feedback contracts.
- @annieqqa and @ShinJuKim: confirm sensor-specific onboarding guidance.

## Boundaries
- Display inference decisions; do not recreate inference logic.
- Call the shared player interface; do not implement a second player.
- Device connections remain with the relevant systems/platform owners.
- Coordinate shared dependency and startup changes with @rohanchakra16.

## Completion evidence
- End-to-end review/recovery using fixtures and the player interface.
- Correct replay requests.
- Accessible interactions.
- Polished loading, failure, and empty states.
- Working onboarding and status presentation.

## Run and test
Add verified startup, fixture/demo, and interaction test commands here.

## Product experience

The product experience is composed in `frontend/src/product/App.tsx`. It uses
the public `src/integration` API, displays live or simulated mode explicitly,
and does not maintain a second bookmark list. Local video is identified by its
file name, size, and last-modified time; playback element events are forwarded
with `attachMediaElement`. Selecting a different video reports the source
change and starts a new session through the client.

Optional WebVTT and SRT caption files populate the transcript. Selecting a
caption seeks to its start. A review suggestion replays the caption containing
the suggested media time, or the nearest preceding caption; “Move earlier”
steps back one caption at a time. This is a caption-boundary rule, not a claim
that every caption is exactly one sentence.

Dismissal is local to the current view and is also sent as feedback; the
authoritative bookmark remains in the integration snapshot. Sensor availability
is shown separately from review suggestions. Synthetic bookmarks and device
states are identified as simulated.

## Development and verification

From `frontend/`, use:

- `npm run dev -- --host 127.0.0.1` and open
  `http://127.0.0.1:5173/?adapter=synthetic` for the self-contained demo.
- `npm test -- src/product/transcript.test.ts` for timed-caption parsing and
  replay-destination tests.
- `npm run typecheck`, `npm run lint`, and `npm run build` for frontend checks.

The browser uses its native media controls. Supported video formats depend on
the browser; files remain local and are not uploaded by the product UI.

## Completion post
Post the branch/PR, demonstrated flow, tests, limitations, and next
handoff on Message Board issue #1.
