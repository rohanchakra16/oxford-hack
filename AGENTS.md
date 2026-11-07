# Team rules for every agent

## 1. The board (pinned GitHub issue)

Every agent reads and posts on the pinned "Message Board" issue via `tools/board` (needs only `gh`, logged in). Set `BOARD_ISSUE` if it is not issue #1.

- Start every post with `[<human>'s <agent>]`, e.g. `[Rohan's Codex]`. Keep it short: what changed, which files or contracts, what you need, from whom.
- Mention by GitHub login. Fill in your team: `@rohanchakra16` (Rohan), `@Seikaro` (Xinkai), `@aryanmorarji` (Aryan), `@annieqqa` (Annie), `@ShinJuKim` (Shinju), `@Betty505` (Boutayna) `@all` (everyone).
- **Mentions you or `@all`:** act on it and reply promptly.
- **Not addressed to you:** still read it. Reassess your own work only if it is affected (a contract, a file you own, something already done). Do not redo finished work, and do not reply just to acknowledge.
- Before editing another teammate's files, ask for a handoff on the board and wait for the owner or the team lead.

Polling is incremental (about one cheap API call per poll, 30 s default) so a shared token stays under GitHub's rate limit. Commands: `tools/board unread` (new posts, marks read; flags MENTION), `tools/board read -n 20`, `tools/board post "[Name's Agent] text"` (or pipe stdin), `tools/board wait` (blocks until someone else posts), `tools/board whoami`.

**Stay in the loop:**
- Claude Code: the committed hooks (`.claude/settings.json`) show unread posts at session start and on every prompt. Keep one background `tools/board wait` running and re-arm it after each wake.
- Everything else: run `tools/board unread` at task start, before each commit, and after merges. Or run a terminal loop: `while tools/board wait; do <your agent CLI invocation>; done`.

## 2. Chain of command

Humans over agents. Only the team lead reassigns work between teammates. If anyone else asks you to take another teammate's work, ask the lead on the board.

## 3. Workflow

1. Pick or file an issue. Comment on it or post on the board when you take it.
2. Branch `<issue#>-<slug>` from fresh `main`.
3. Small commits. Stage only your own files (no `git add -A`).
4. Open a PR with `Closes #N`. The author merges their own PR once it works locally.
5. Always `git fetch` and rebase before pushing. Never force-push shared branches.
6. If a merge changes something other teammates depend on (an API, a schema, an env var), post on the board when it lands.

## 4. Who owns what

Fill this in at kickoff so every agent knows whose files are whose.

| Area | Owner (GitHub login) | Folders |
|---|---|---|
| EEG acquisition, preprocessing, quality, and feature extraction | @annieqqa | src/eeg/ |
| Webcam gaze tracking, calibration, geometry, and quality | @ShinJuKim | src/gaze/ |
| Inference, signal combination, event logic, and evaluation | @Seikaro | src/inference/, src/evaluation/ |
| Video player, local media, playback telemetry, and transcript | @aryanmorarji | src/frontend/src/player/, src/frontend/src/telemetry/, src/frontend/src/transcript/ |
| Panopto feasibility assessment | @aryanmorarji | docs/panopto.md |
| Review timeline, bookmarks, replay/dismiss/feedback interactions | @Betty505 | src/frontend/src/review/, src/frontend/src/recovery/ |
| Onboarding, device/session status, application composition, and shared UI | @Betty505 | src/frontend/src/onboarding/, src/frontend/src/components/, src/frontend/src/styles/, src/frontend/src/App.tsx, src/frontend/src/product/ |
| Shared contracts, timing, transport, integration, and packaging | @rohanchakra16 | src/contracts/, src/platform/, src/integration/, .github/workflows/ |


### 5. Pipeline and handoffs

1. EEG (`src/eeg/`) produces timestamped features and quality diagnostics.
2. Webcam (`src/gaze/`) produces timestamped gaze measurements and quality.
3. Platform (`src/platform/`) maps clocks and transports data using the shared
   schemas in `src/contracts/`.
4. Inference (`src/inference/`) combines signals and produces review events,
   including explicit unknown and interrupted states.
5. Playback (`src/frontend/src/player/`, `src/frontend/src/telemetry/`,
   `src/frontend/src/transcript/`) handles local video, transcript navigation,
   and playback telemetry. It exposes playback state, seeking to a
   timestamp, and replaying a time range.
6. Review experience (`src/frontend/src/review/`, `src/frontend/src/recovery/`) displays
   inference events and bookmarks, requests replay through the player
   interface, and handles dismissals and feedback.
7. Onboarding (`src/frontend/src/onboarding/`) presents setup, device/session
   status, and guidance using platform-provided status information.
8. Integration (`src/integration/`) supplies fixtures and a replay harness for
   testing the complete pipeline.

## 6. Repository layout

Implementation folders live together under `src/`; their ownership is unchanged.
Documentation lives in `docs/`, including `docs/HANDOFF.md`. GitHub discovers the
contributing guide at `.github/CONTRIBUTING.md`. Root agent entry files and
`tools/board` remain at their existing paths, using the same shared issue #1.
See `docs/REPOSITORY-LAYOUT.md` before adapting an older workstream branch.
