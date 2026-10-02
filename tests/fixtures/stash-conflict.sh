#!/usr/bin/env bash
# fixture: stash-conflict
# description: stash@{0} "wip s.txt" modifies line 2 of s.txt; HEAD then modifies the same line (apply in conflict); worktree own
# refs: refs/heads/main refs/stash
# head: main
# worktree: clean
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

fx_init
fx_write README.md "# Fixture gitmini"
fx_write s.txt "$(fx_ligne3)"
fx_commit_all "base: init"

fx_write s.txt "$(fx_ligne3 ' (stash)')"
fx_stash -m "wip s.txt"

fx_commit s.txt "$(fx_ligne3 ' (HEAD)')" "HEAD: modifies s.txt"

fx_done
