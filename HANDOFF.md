# HANDOFF — Person 5 (platform & integration)

Branch: `infra/shared-foundation` (not merged; do not merge without team review)
Last updated: 2026-11-07, during the initial build session.

## 1. Objective and ownership

Reliable, reviewable foundation the other four workstreams connect to: shared contracts, transport,
clock sync + playback mapping, integration harness, repo tooling/CI, local-service security.

| Person | Owns |
|---|---|
| P1 | EEG acquisition, quality, filtering, features (`backend/src/oxford_hack/eeg/`, beyond `interface.py`) |
| P2 | Webcam gaze + calibration (`frontend/src/gaze/`, not created yet) |
| P3 | Models, combination, decision state machine (`backend/src/oxford_hack/inference/`, beyond `interface.py`) |
| P4 | Product UI, player, transcript, bookmark UI (`frontend/src/product/`) — boundary PROPOSED in `docs/frontend-integration.md` |
| P5 | `contracts/`, `backend/src/oxford_hack/{contracts,timing,session,transport,harness}`, `frontend/src/{contracts,integration,diagnostics}`, CI, setup |

## 2. Completed (committed)

- `d9fa7c3` Proposed v0.1.0 contracts: pydantic source (`backend/src/oxford_hack/contracts/`),
  generated JSON Schema (`contracts/schema/`), 24 valid + 16 invalid synthetic fixtures.

## 3. Tests actually run

- Ad-hoc: every valid fixture parses; every invalid fixture is rejected with its `expectedCode` (Python).
- Ad-hoc simulation (not yet a committed test): hub + synthetic browser with 123 s clock offset and jitter;
  bookmarks mapped to the expected media time (verified by hand: 30 s + 21.35 s elapsed = 51.35 s).
- No pytest/vitest suite committed yet. No CI run yet.

## 4. In progress / uncommitted

- Backend (written, not yet tested or committed): `timing/` (clock sync, device clock, playback mapping),
  `session/` (hub, sensor monitor), `transport/app.py` (FastAPI, handshake, WS, test hooks),
  `harness/` (synthetic EEG, placeholder inference, deterministic simulator), `eeg/interface.py`,
  `inference/interface.py`. Missing: `cli.py`, replay, recorder, tests.
- Frontend (written, not yet tested or committed): package setup + lockfile, generated TS types,
  ajv validator, integration interface/store/reporter/live client. Missing: synthetic adapter, index,
  diagnostics page, tests.

## 5. Known issues / decisions awaiting agreement

- Contracts are PROPOSED. Exact-match `schemaVersion` policy (any change bumps the version).
- One session = one video. Bookmarks do not survive a backend restart (by design for now).
- Frontend boundary with P4 is PROPOSED (`docs/frontend-integration.md`, being written).
- Sandbox notes for this machine: npm/uv need `npm_config_cache=$TMPDIR/npm-cache` /
  `UV_CACHE_DIR=$TMPDIR/uv-cache` inside the Claude sandbox; git network ops need github.com allowed.

## 6. Next steps

1. Synthetic adapter + `docs/frontend-integration.md` + vitest tests -> commit "frontend integration interface".
2. Backend pytest suite (timing, hub, transport, contracts) -> commit per area.
3. `cli.py` (serve/replay), recorder, replay sample, root `npm run dev`.
4. Diagnostics page, Playwright (`frontend/e2e/`), CI workflows, docs.

Resume commands:
```bash
cd backend && uv sync && uv run pytest
cd frontend && npm ci && npm test
```

## 7. Failed approaches (don't repeat)

- `uv run` directly after a failed `uv sync` left the project not importable; `uv sync --reinstall-package oxford-hack-backend` fixed it.
- ajv's `discriminator` keyword rejects pydantic's `mapping`; the frontend validator selects the schema by `type` instead.
