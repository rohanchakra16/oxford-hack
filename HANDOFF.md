# HANDOFF — Person 5 (platform & integration, @rohanchakra16)

Foundation merged to `main` (PR #2), then simulated-detector wiring (PR #9). The team lead has authorised merging infra work to `main` once CI passes.
Last updated: 2026-11-07.

## 1. Objective and ownership

Reliable, reviewable foundation the other workstreams connect to: shared contracts, transport,
clock sync and playback mapping, integration harness, repo tooling and CI, local-service security.
Ownership follows `AGENTS.md` §4. P5 owns `contracts/`, `platform/`, `integration/` and `.github/workflows/`,
plus the frontend integration layer (`frontend/src/{contracts,integration,diagnostics}`), as proposed in
`docs/frontend-integration.md`. That doc is PROPOSED and still needs agreement from @aryanmorarji and @Betty505.

## 2. Completed (committed and pushed)

| Commit | What |
|---|---|
| `d9fa7c3` | Proposed v0.1.0 contracts: pydantic source, generated JSON Schema, 24 valid + 16 invalid fixtures |
| `50bce8f` | Frontend `ReviewClient` interface, live adapter, synthetic adapter, ajv validator, `docs/frontend-integration.md` |
| `ffa9373` | Clock sync, device-clock mappers, playback segment mapping |
| `46caa66` | Session hub, P1/P3 adapter interfaces, synthetic producers, deterministic simulator, record/replay |
| `5d8f731` | FastAPI/WebSocket transport, origin/host/token checks, test hooks (opt-in), `oxford-backend serve/replay` |
| `4b408a4` | CI (platform + frontend jobs), PR template |
| `0875430` | `backend/` moved to `platform/` to match `AGENTS.md` |
| PR #2 | All of the above merged to `main` (CI green) |
| PR #13 | `/diagnostics` page + Playwright infra e2e (13 tests) + CI job `e2e-infra`. CI green, merged |
| PR #4 | Aryan's player + transcript, merged by me after CI 3/3 and a local merge-result check |
| PR #17 | Real-video player e2e tests + `frontend/e2e/README.md`. CI green, merged |
| PR #9 | Simulation-only policy; `--simulated-detector {placeholder,baseline}`; CI also runs `inference/tests` and `evaluation/tests`. CI green, merged |

## 3. Tests actually run (locally, macOS, Python 3.12.4, Node 26)

- platform: `ruff check`, `ruff format --check`, `mypy` (strict) clean; `pytest`: 121 passed.
- frontend: `eslint`, `tsc -b` clean; `vitest`: 56 passed. The live adapter is unit-tested against a fake socket only.
- Drift checks: schema, fixtures, sample recording and TS types are all up to date.
- Manual serve smoke test: health ok, foreign Host header gets 421, test hooks get 404 by default.
- CI: not yet run on GitHub at the time of writing; see the PR.

## 4. In progress / not started

- Developer diagnostics page (`frontend/src/diagnostics/`): placeholder only.
- Playwright infra tests (`frontend/e2e/infra/`) and CI job: not started.
- Root `npm run dev` (starts platform and frontend together): not started.
- `--eeg-source module:factory` CLI hook for P1's adapter: not started.
- Docs: `docs/TIMING.md`, `docs/SECURITY.md`, `docs/INTEGRATION.md`, `docs/REPLAY.md`, `contracts/README.md`.
  These are referenced in code comments but not written yet.

## 4b. Integration state (updated after lead's layout decision: keep current layout, src/ migration deferred)

Merged by me, CI green: #24 (Annie's #14 integrated under `eeg/`), #25 (Betty's #11 integrated with the shared
player/transcript), #29 (`--eeg-source`, and the previously unwired `--simulated-detector`). GitHub shows #11 and #14 as merged
because their commits are ancestors of main. #26 (Seikaro's src/ move) is a DRAFT and deferred: do not merge.

Verified on combined main: platform ruff/mypy/pytest, P3 tests (1 optional skip), `eeg` tests (non-GUI locally; GUI in CI),
frontend lint/typecheck/104 unit/build, 22 Playwright tests, schema/fixture/recording/type drift checks, and `npm run dev`
start plus shutdown on SIGINT and SIGTERM with ports 8765 and 5173 released and no leftover processes.

Still open (explicit):
- **Hardware**: the Unicorn adapter has never run on a real headset. g.Pype alternative and its licence/macOS thread
  caveats are on the board (ShinJu).
- **EEG to hub**: `--eeg-source` loads any `EegSource`, but no mapper exists from Annie's `StreamingController` frames to
  `EegFeatureWindow` (names/units, quality flags, clock correction); who computes the features is undecided.
- **Gaze wiring**: no gaze code on main yet. Proposal: `file:../gaze` dependency and an adapter around
  `player.getVideoElement()` and `client.sendGazeObservations/sendGazeCalibration`, done when ShinJu opens a PR.
- **Qt GUI test**: the PySide6 process crashes at exit on Linux CI after passing; CI gates on JUnit and warns.
- **question_request** (Seikaro's new P3 task) needs a contract change from me with a schemaVersion bump; payload pending.
- Bookmarks do not survive a backend restart (decision for lead/Betty).

## 4c. Main app status after the integration-readiness round (2026-11-08)

Merged: #49 (schema 0.2.0), #50 (replay fix), #53 (CI main-page browser tests), #54, #56 (gaze 0.2.0 + real-adapter compat test), #57 (visual refinement; screenshots in `docs/design/{before,after}`).

**Demo (verified in CI with scripted EEG, synthetic webcam):** `npm run dev -- --rehearsal`, open the printed URL (Vite, default http://127.0.0.1:5173). Mode: test EEG + real webcam; the page shows the "Test EEG + real webcam" banner. Physical-live mode never falls back to mock data.

| Feature | In main app? | Synthetic/replay verification | Actual webcam | Physical EEG | Remaining gap / owner |
|---|---|---|---|---|---|
| Local video + transcript + sentence replay | yes | CI e2e | n/a | n/a | none |
| EEG-only reminder + bookmark | yes | CI main-eeg e2e, rehearsal e2e | n/a | NOT verified | real headset + Annie's score contract (Annie) |
| Gaze to backend, calibration | yes | CI live-product e2e (fake camera) | NOT verified | n/a | lead/ShinJu to run with a real camera |
| Combined EEG+gaze bookmark | yes | CI main-product / live-product | NOT verified | NOT verified | combined semantics sign-off (Annie/Seikaro/ShinJu) |
| Replay / dismiss / feedback | yes | CI e2e | n/a | n/a | none |
| Unavailable/stale/interrupted/disconnected | yes | infra e2e robustness | n/a | NOT verified | none known |
| Calibration persistence (save/reset, versioned localStorage) | NO | none | none | n/a | authorised; awaiting Seikaro on gaze-runtime/GazeCalibration/focus files |
| Attention graph (#55) | NO (components pending) | none | none | none | Aryan supplies; mount point is the player `overlay` slot + sidebar; live mode must show markers and "Live score unavailable", never a fabricated curve |
| Live attention score | NO | none | none | none | Annie's score contract (scale/direction, threshold + comparison, evidence timestamps/cadence, quality/warmup states, smoothing already applied, versions/provenance) is UNCONFIRMED |

Score dependencies: smoothing (EMA 5 s), threshold (30), recovery (45/4 s), 8 s dwell and 30 s cooldown live in `inference/live_attention.py`; 0.6/0.4 combined weighting in `inference/live_combined.py`. Do not apply these to a new score scale without agreeing the contract (risk of double smoothing).

g.Pype: see `docs/GPYPE.md`; recommendation unchanged (keep the current source, add alongside via the shared `EegSource` interface); exact Unicorn BCI Core variant, library version and laptop still unconfirmed.

Known: Qt GUI teardown crash in CI is gated on JUnit; bookmarks do not survive a backend restart; Impeccable not installed (published rules applied by hand).

## 4d. Product redesign (PR #71, branch design-2, NOT merged: lead chooses the visual direction)

- Owner: Rohan's Claude owns final composition and visual design (frontend/src/product/, LecturePlayer styling).
- Variant A (default, preserved): dark stage + tabbed side panel (Transcript / Moments / Attention), import card when empty, setup modal.
- Variant B: restrained neo-brutalist treatment of the loaded screen, opt-in with `?design=brutal` (frontend/src/product/brutal.css). Refs: bergside/awesome-design-skills `neobrutalism` (tokens) and neobrutalism.dev (button/tabs/badge/alert/slider structure via its registry; theme tokens were not retrievable, so shadow offsets and radii are our own choice). Delete brutal.css and the `data-design` line in App.tsx to drop it.
- Usability fixes: narrow controls dock under the video; camera failures are classified from the engine's real cause (permission / missing / busy / unknown) and an unrecognised failure is never described as a permission denial; "Annie's model" wording removed; setup is shorter with technical text under details; graph/calibration messages follow the actual HTTP status (409/404/501/503 = no compatible score source; 401/403 = pairing rejected; otherwise unreachable/retrying).
- Verified (automated): calibration dot centres match requested viewport coordinates within 1 px at 1440x900, 1280x720, 390x844 with the setup dialog open (frontend/e2e/live/calibration-geometry.spec.ts, stand-in camera). NOT verified: real-camera gaze accuracy; that needs a person and a webcam.
- E2E selector notes: moment cards need the Moments tab, graph/demo controls need the Attention tab.
- Screenshots: docs/design/before2 (rejected baseline), after7 (current narrow/laptop), compare/ (A vs B, same lecture and viewport).

## 5. Known issues and decisions awaiting the team

- Contracts are PROPOSED. `schemaVersion` must match exactly, and any change bumps it.
- `person2/webcam-gaze` adds `packages/gaze/schema/gaze_observation.v0.schema.json`, which competes with the shared
  `gaze_observations` / `gaze_calibration` contract. It needs reconciling with @ShinJuKim; I haven't edited their files.
- `feature/EEG-input` (@annieqqa) is a root-level pip project (`requirements.txt`, `eeg/`) with `config.yaml` hard-coding
  250 Hz / 8 channels. Their adapter should implement `oxford_hack.eeg.interface.EegSource`. How it's loaded is still open.
- Board: `bash tools/board post "[Rohan's Claude] ..."` (the script is not executable on checkout). Posted the PR #9 policy note.
- One session per video. Bookmarks don't survive a backend restart.
- Sandbox on this machine: npm and uv need `npm_config_cache=$TMPDIR/npm-cache` and `UV_CACHE_DIR=$TMPDIR/uv-cache`.
  Binding local ports and `git` network operations need running outside the sandbox (or `allowLocalBinding`).

## 6. Next steps

1. Rebase `infra/diagnostics-wip` onto main and finish the diagnostics page.
2. Then Playwright infra tests and a CI job.
3. `npm run dev`, then the docs listed above.

```bash
cd platform && uv sync --locked && uv run pytest
cd frontend && npm ci && npm test
```

## 7. Failed approaches (don't repeat)

- `uv run` after a failed `uv sync` left the package unimportable. `uv sync --reinstall-package <name>` fixed it.
- ajv's `discriminator` rejects pydantic's `mapping`. The frontend validator picks the schema by `type` instead.
- `tsc -b` without `noEmit` wrote `.js` files next to the sources. Both tsconfigs now set `noEmit`.
- The simulated network delivered messages out of order. Real WebSockets are FIFO, and the simulator now is too.
- WebSocket TestClient connections default to the `testserver` host, which the loopback Host check rejects.
  Tests use `ws://127.0.0.1:8765/...`.
