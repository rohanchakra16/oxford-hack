# Shared contracts (Person 5)

Single source of truth: the pydantic models in `src/platform/src/oxford_hack/contracts/` (`base`, `payloads`, `messages`).
Generated from them and committed:

- `src/contracts/schema/oxford-hack.schema.json` (JSON Schema bundle)
- `src/contracts/fixtures/valid/*.json` (one per message type) and `src/contracts/fixtures/invalid/*.json`
- `src/contracts/fixtures/recordings/synthetic-session.v1.jsonl` (synthetic sample, see `docs/REPLAY.md`)
- `src/frontend/src/contracts/generated/` (TypeScript types)

```bash
npm run contracts:generate   # from the repo root; regenerates all of the above
npm run contracts:check      # CI runs this; fails on drift
```

Rules: `SCHEMA_VERSION` (currently `0.1.0`, PROPOSED) must match exactly on both sides. Any change bumps it. Times carry
their unit and clock in the field name (`...BackendMs`, `...BrowserMs`, `...MediaS`). Missing values are `null` with a
reason, never `0`. The frontend validates structure with the schema; cross-field rules (for example a candidate's
signals matching its mode) are enforced by the backend only. Message owners and directions are listed in the
`MESSAGES` registry in `messages.py`.
