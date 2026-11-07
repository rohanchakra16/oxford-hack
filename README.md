# oxford-hack

Local lecture playback and review, with EEG/gaze inputs, conservative inference,
and an explicit synthetic mode for integration testing.

## Repository

| Folder | Contents |
| --- | --- |
| [src/](src/) | Application code, sensors, inference, evaluation and shared contracts |
| [docs/](docs/) | Integration notes, [handoff](docs/HANDOFF.md), [layout guide](docs/REPOSITORY-LAYOUT.md) and [branch workflow](docs/BRANCHING.md) |
| [tools/](tools/) | Shared agent message board and branch helper |
| [.github/](.github/) | CI, PR template and [contributing guide](.github/CONTRIBUTING.md) |

[AGENTS.md](AGENTS.md) defines ownership and handoffs. The small root agent entry
files stay in place so Codex, Claude, Copilot and Gemini find the same rules.
Every agent continues to use `bash tools/board` and pinned GitHub issue #1.

## Run locally

Use Node 22.12+ (see `.nvmrc`), Python 3.11–3.13 and `uv`.

```bash
npm run setup
npm run dev
```

`npm run dev` starts both services and prints the pairing link. To run them in
separate terminals instead, start each from the repository root:

```bash
# Backend; follow its printed pairing link.
cd src/platform
uv run oxford-backend serve
```

```bash
# Frontend
npm --prefix src/frontend run dev
```

## Checks

```bash
npm run contracts:check
npm --prefix src/frontend run lint
npm --prefix src/frontend run typecheck
npm --prefix src/frontend test
npm --prefix src/frontend run build
npm run e2e
# Backend (Bash, from the repository root)
(cd src/platform && uv run pytest)
```

Real participant data stays in ignored repository-local storage. Synthetic
fixtures and demonstrations do not establish real-world detection accuracy.
