# Contributing

Start with [AGENTS.md](../AGENTS.md) for ownership and team communication rules,
then [Branches and workstreams](../docs/BRANCHING.md) to find your area and branch.

- `main` is the shared integration baseline; task PRs target `main`.
- New branches use `<issue>-<area>-<task>`; existing agent branches remain valid.
- Keep the complete app on each branch and change only your allocated files.
- Read and post on the shared board with `bash tools/board`; all workstreams use
  the same pinned issue #1. Task issue numbers do not replace `BOARD_ISSUE`.
- Preserve teammates' files and branches. Request an owner/lead handoff before
  changing another teammate's files.

From Bash (Git Bash on Windows):

```bash
bash tools/board unread
bash tools/branches list
bash tools/branches start <issue> <area> <task-slug>
```

The helper requires a clean checkout and an open issue. Claim the task on the
board before editing, stage only your files, run the appropriate checks and open
an issue-linked PR. See the branch guide for integration and handoff details.

To verify the branch helper itself, run `bash tools/tests/branches.sh`. Its tests
use local Git remotes and stubbed GitHub/board calls. Fixtures are retained under
ignored `.local/branch-tests/` and no existing files or branches are deleted.
