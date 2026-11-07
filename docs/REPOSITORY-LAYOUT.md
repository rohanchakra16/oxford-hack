# Repository layout

The root groups implementation, documentation and tooling. All original files
are retained; moves are recorded as Git renames and ownership is unchanged.

```text
.
├── .github/                 CI, PR template, CONTRIBUTING.md
├── docs/                    design/integration notes, HANDOFF.md
├── src/
│   ├── contracts/           shared schema and synthetic fixtures
│   ├── eeg/                 EEG workstream
│   ├── evaluation/          labels, splits, event metrics
│   ├── frontend/            Vite app, player, transcript, review, diagnostics
│   ├── gaze/                webcam workstream
│   ├── inference/           detector and versioned configuration
│   ├── integration/         combined development launcher
│   └── platform/            local Python backend and integration harness
├── tools/                   board and branch helpers
├── AGENTS.md                shared agent rules and ownership
├── CLAUDE.md / CODEX.md / COPILOT.md / GEMINI.md
├── README.md
├── package.json             root setup and contract commands
├── .gitignore
└── .nvmrc
```

The agent entry files remain at the root for discovery. `.github/` stays in its
required location, and GitHub discovers the contributing guide there. Local
state such as `.local/`, `.board/`, virtual environments and dependency folders
is ignored and does not appear in the GitHub tree.

## Path changes

| Previous location | Current location |
| --- | --- |
| `contracts/`, `eeg/`, `evaluation/`, `frontend/`, `gaze/`, `inference/`, `integration/`, `platform/` | The same sibling folders under `src/` |
| `HANDOFF.md` | `docs/HANDOFF.md` |
| `CONTRIBUTING.md` | `.github/CONTRIBUTING.md` |

Internal sibling imports and fixture paths remain intact. CI working directories,
cache paths, artifacts and root npm commands use the new locations. The backend
launch token remains at repository-root `.local/launch-token`, and label output
remains restricted to repository-root `data/`.

## Continuing an older agent branch

Existing branches and PRs are retained. Their owners adapt them after fetching
current `main`; this migration does not change anyone else's branch.

- Keep uncommitted work intact. Use a separate checkout when another agent is
  using the same working tree.
- Follow AGENTS.md for rebasing and pushing; never force-push a shared branch.
- Git can detect existing-file renames during integration. Check newly added
  files too: they belong in the corresponding `src/<area>/` folder. Resolve any
  rename conflicts without discarding either side's content.
- Owners of pending EEG/gaze/product work keep their responsibilities. Package
  manifests, workspaces and frontend-internal component organization are not
  changed by this migration. Coordinate extra root files from an older PR on
  the board before merging them.
- Recreate or reinstall dependencies at the new locations using `npm run setup`;
  do not move or delete another checkout's environment or caches.

For direct Python inference/evaluation commands from the repository root, use:

```bash
export PYTHONPATH="$PWD/src:$PWD/src/platform/src"
python -m pytest src/inference/tests src/evaluation/tests
```

In PowerShell, set `$env:PYTHONPATH = "$PWD/src;$PWD/src/platform/src"`.
Use an environment with the platform and test dependencies installed.

## Agent communication

`AGENTS.md`, root agent shims and `tools/board` keep their paths. All workstreams
continue to communicate on the same pinned issue #1 using the same `BOARD_REPO`,
`BOARD_ISSUE` and mention rules. The shared contracts' message shapes and schema
version are unchanged.
