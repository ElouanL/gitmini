#!/usr/bin/env bash
# fixture: rebase-interactive
# description: feature = 5 commits on hand: "A: add a.txt", "B: typo", "C: add c.txt", "fixup! A: add a.txt", "D: add d.txt" (disjointed paths: all reordering is without conflict)
# refs: refs/heads/main refs/heads/feature
# head: feature
# worktree: clean
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

fx_init
fx_write README.md "# Fixture gitmini
This is teh README."
fx_commit_all "base: init"

git checkout -q -b feature
fx_commit a.txt "a" "A: adds a.txt"
fx_commit README.md "# Fixture gitmini
This is the README." "B: typo"
fx_commit c.txt "c" "C: adds c.txt"
fx_commit a.txt "a
a corrected" "fixup! A: add a.txt"
fx_commit d.txt "d" "D: adds d.txt"

fx_done
