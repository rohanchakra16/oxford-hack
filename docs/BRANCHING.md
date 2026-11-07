# Branches and workstreams

`main` is the shared integration baseline. Each task branches from current
`origin/main`, changes one workstream where possible, and returns through a PR.
Every branch keeps the complete application so agents can test integration.
Folders are ownership boundaries; they do not need to be split into separate
repositories or removed from `main`.

This guide supplements [AGENTS.md](../AGENTS.md); its ownership, handoff and
message-board rules still apply. No existing branch or file is removed or renamed
by this cleanup. Do not delete teammates' work. Ask the owner and team lead before
changing files outside your allocation.

## Find the right workstream

| Area in new branch names | Owner | Files and integration boundary |
| --- | --- | --- |
| `eeg` | @annieqqa | `eeg/`; emits timestamped EEG features and quality |
| `gaze` | @ShinJuKim | `gaze/`; emits gaze measurements and calibration/quality |
| `inference` | @Seikaro | `inference/`, `evaluation/`; combines signals and produces review candidates |
| `playback` | @aryanmorarji | Player, telemetry capture and transcript; `docs/panopto.md` |
| `review` | @Betty505 | Review/recovery, onboarding, shared UI and application composition |
| `platform` | @rohanchakra16 | `contracts/`, `platform/`, `integration/`, `.github/workflows/`; transport, timing and packaging |
| `repo` | Coordinate with @rohanchakra16 / the team lead | Repository documentation and tooling; this area grants no additional file ownership |

The tracked Vite application lives in `frontend/src/`. Playback work is being
developed in `frontend/src/player/` in PR #4. The `frontend/src/` interpretation
of other frontend allocations and shared integration ownership is described in
[the frontend integration proposal](frontend-integration.md). Ask the relevant
owners to resolve those proposals before moving folders or changing imports.

## Existing work stays where it is

Snapshot from 7 November 2026; use GitHub and the board for current status.

| Existing branch | Workstream | Continuation |
| --- | --- | --- |
| `feature/EEG-input` | EEG | Owner continues on this branch |
| `person2/webcam-gaze` | Gaze | Owner continues on this branch |
| `5-inference-evaluation` | Inference / evaluation | Task branch for #5; owner continues inference / evaluation |
| `person4/video-player` | Playback | Keep draft PR #4 targeting `main`; tracks #3 |
| `infra/diagnostics-wip` | Platform | Owner continues diagnostics work |
| `infra/shared-foundation` | Platform | PR #2 merged; retained for history |
| `6-repo-branch-workflow` | Repository | Additive cleanup tracked by #6 |

Existing names are grandfathered in. Do not create replacement copies just to
rename them, repoint someone else's branch, or retarget their PR. New work uses
`<issue>-<area>-<task>`, which follows AGENTS.md's `<issue#>-<slug>` rule.
For example: `12-gaze-calibration-quality` or `13-review-replay-controls`.
The example issue numbers are illustrative; create or select an actual issue.

## Start a task

Use Bash (Git Bash on Windows) from the repository root:

```bash
bash tools/board unread
bash tools/branches list
gh issue list --state open
# Pick an existing issue, or create a focused issue with gh issue create.
bash tools/branches start 12 gaze calibration-quality
bash tools/board post "[Shinju's Codex] Taking #12 on 12-gaze-calibration-quality; gaze/ only. @rohanchakra16 please flag contract changes."
```

The helper requires a clean checkout and an open issue, reads the existing board,
fetches `origin`, and creates a local task branch from `origin/main`. It refuses
to overwrite an existing local or remote branch. It does not stash files,
publish branches or change the checked-out `main` pointer. If local edits are
present, keep them intact and use a separate clean checkout; do not clean/reset
the checkout to make the helper run.

## Keep agents communicating

All branches use **the same pinned GitHub issue #1**, through the existing
`tools/board`. Set `BOARD_ISSUE` only if the board has actually moved; do not set
it to your task issue number. `BOARD_REPO` can explicitly identify the common
repository when needed. These variables and the board's existing behavior are
unchanged.

- Prefix every post with `[<human>'s <agent>]`; mention GitHub logins or `@all`.
- Include the task issue, branch, files/interfaces affected, and the person you
  need a response from.
- Read unread posts at task start, before each commit, and after merges. Act on
  mentions and reply promptly. A bounded wait is also available:
  `bash tools/board wait --timeout 30`.
- Request and receive an owner/lead handoff on the board before editing another
  teammate's files. A new branch name does not grant ownership.
- Before merging a contract, schema, environment variable or integration change,
  state who needs to adopt it. Post again when it lands on `main`.

The board's `.board/` cache remains ignored and local. Separate checkouts may
show some messages again because their read cursors are separate; all read and
write the same GitHub issue. Do not commit or manually copy cursor files.

## Finish and integrate

1. Run checks appropriate to the changed area. Existing CI checks the platform
   and frontend for PRs targeting `main`.
2. Read the board, review `git diff`, and stage only your own named files.
3. Fetch and rebase on `origin/main` before pushing, as required by AGENTS.md.
   Do this only with a clean checkout and no concurrent agent using that checkout.
4. Push with `git push -u origin <branch>` and open a PR targeting `main` with
   `Closes #N`, checks run, affected owners and any handoff requirements.
5. Authors merge their own PR once the required checks and handoffs are satisfied.
   Read the board after merging and announce integration changes there.

Never force-push a shared branch. If rebasing already-published work would need
a force push, leave the remote branch intact and coordinate with its owner/lead;
an additive follow-up branch and PR can carry the changes. Do not delete local
or remote branches after merging during this cleanup.

## Run the unchanged application

The task branches use the same setup and integration interfaces as `main`:

```bash
npm run setup
# Terminal 1
cd platform
uv run oxford-backend serve --help
# Terminal 2, from the repository root
npm --prefix frontend run dev
```

Use the backend CLI's `--help` for launch and pairing options. Standard checks
are `uv run pytest` from `platform/`, and
`npm run lint`, `npm run typecheck`, `npm test`, `npm run build` from `frontend/`.
Changing branch organization does not change schemas, runtime imports, playback
interfaces or transport routing.
