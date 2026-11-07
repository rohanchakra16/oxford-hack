#!/usr/bin/env bash
# Integration checks use local Git remotes and stub gh/board; no GitHub mutations.
set -euo pipefail
source_root="$(git rev-parse --show-toplevel)"
mkdir -p "$source_root/.local/branch-tests"
case_root="$(mktemp -d "$source_root/.local/branch-tests/run.XXXXXX")"
printf 'Keeping test fixtures at %s\n' "$case_root"
mkdir -p "$case_root/work/tools"
cp "$source_root/tools/branches" "$case_root/work/tools/branches"
gh() {
  [ "${TEST_GH_FAIL:-0}" != 1 ] || return 1
  printf '%s\n' "${TEST_ISSUE_STATE:-OPEN}"
}
export -f gh
cat > "$case_root/work/tools/board" <<'BOARD'
#!/usr/bin/env bash
[ "$1" = unread ] || exit 1
printf 'unread\n' >> "$TEST_BOARD_LOG"
[ "${TEST_BOARD_FAIL:-0}" != 1 ]
BOARD
export TEST_BOARD_LOG="$case_root/board.log"
git init --bare -q "$case_root/origin.git"
cd "$case_root/work"
git init -q -b main
git config user.name 'Branch helper test'
git config user.email 'branch-test@example.invalid'
git config commit.gpgsign false
printf 'baseline\n' > tracked.txt
git add tracked.txt tools/branches tools/board
git commit -q -m baseline
git remote add origin "$case_root/origin.git"
git push -q -u origin main

fail() { echo "FAIL: $*" >&2; exit 1; }
expect_failure() {
  local label="$1" before_branch before_head
  shift
  before_branch="$(git branch --show-current)"
  before_head="$(git rev-parse HEAD)"
  if "$@" > "$case_root/$label.log" 2>&1; then fail "$label unexpectedly succeeded"; fi
  [ "$(git branch --show-current)" = "$before_branch" ] || fail "$label switched branches"
  [ "$(git rev-parse HEAD)" = "$before_head" ] || fail "$label moved HEAD"
  printf 'PASS: %s leaves branch and HEAD intact\n' "$label"
}

bash tools/branches list > "$case_root/list.log"
grep -q 'origin/main' "$case_root/list.log" || fail 'list omitted origin/main'
expect_failure invalid-issue bash tools/branches start 0 gaze task
expect_failure invalid-area bash tools/branches start 12 other task
expect_failure invalid-slug bash tools/branches start 12 gaze 'bad/slug'
expect_failure extra-arguments bash tools/branches start 12 gaze task extra
TEST_ISSUE_STATE=CLOSED expect_failure closed-issue bash tools/branches start 12 gaze task
TEST_GH_FAIL=1 expect_failure unavailable-issue bash tools/branches start 12 gaze task

printf 'preserve me\n' > untracked.txt
expect_failure dirty-checkout bash tools/branches start 12 gaze task
grep -q 'preserve me' untracked.txt || fail 'untracked work changed'
git add untracked.txt
git commit -q -m 'keep local work'
TEST_BOARD_FAIL=1 expect_failure board-failure bash tools/branches start 12 gaze task
git show-ref --verify --quiet refs/heads/12-gaze-task && fail 'board failure created branch'

# Advance remote main without advancing local main, then prove start uses the remote.
git switch -q -c upstream-change
printf 'new remote baseline\n' > remote-marker.txt
git add remote-marker.txt
git commit -q -m 'remote main advances'
remote_head="$(git rev-parse HEAD)"
git push -q origin HEAD:main
git switch -q main
local_main="$(git rev-parse main)"
bash tools/branches start 12 gaze task > "$case_root/start.log" 2>&1
[ "$(git branch --show-current)" = 12-gaze-task ] || fail 'wrong branch created'
[ "$(git rev-parse HEAD)" = "$remote_head" ] || fail 'did not start at fresh origin/main'
[ "$(git rev-parse main)" = "$local_main" ] || fail 'local main moved'
[ -z "$(git for-each-ref --format='%(upstream)' refs/heads/12-gaze-task)" ] || fail 'task tracks main'
[ -s "$TEST_BOARD_LOG" ] || fail 'board was not read'
printf 'PASS: start reads board and uses fresh origin/main without moving local main\n'

git switch -q main
expect_failure existing-local bash tools/branches start 12 gaze task
git push -q origin main:refs/heads/13-review-task
expect_failure existing-remote bash tools/branches start 13 review task
git remote set-url origin "$case_root/missing.git"
expect_failure fetch-failure bash tools/branches start 14 eeg task
git show-ref --verify --quiet refs/heads/14-eeg-task && fail 'fetch failure created branch'
printf 'merge in progress\n' > "$(git rev-parse --git-path MERGE_HEAD)"
expect_failure unfinished-merge bash tools/branches start 15 platform task
printf 'All branch-helper checks passed. No fixture files were deleted.\n'
