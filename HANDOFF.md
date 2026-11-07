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

## 4b. Open PRs I reviewed for merge (not merged)

- #11 (Betty, draft): still has its own `<video>`+`attachMediaElement` and `product/transcript.ts`; she agreed on the board to
  switch to `LecturePlayer`/`TranscriptPanel` and Aryan's sentence replay rule. Waiting for her rebase; then merge + product e2e.
- #14 (Annie, EEG input): conflicts in `.gitignore`; replaces the root README with the EEG README; project files at repo root
  (`main.py`, `config.yaml`, `requirements.txt`, `tests/`) instead of `eeg/`; empty description. Her 29 tests pass. Asked her on the board.
- Seikaro's folder-restructure proposal (#15): a lead decision, not mine; no files moved.

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
