#!/usr/bin/env bash
# fixture: rebase-conflict
# description: 3 commits on hand and 2 on feature; the 1st commit replayed feature conflicts on conflict.txt (line 2), the 2nd applies without conflict
# refs: refs/heads/main refs/heads/feature
# head: feature
# worktree: clean
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

fx_init
fx_write README.md "# Fixture gitmini"
fx_write conflict.txt "$(fx_ligne3)"
fx_commit_all "base: init"

# hand: the 2nd commit modifies the line 2 of conflict.txt
fx_commit main1.txt "main 1" "main: add main1.txt"
fx_commit conflict.txt "$(fx_ligne3 ' (main)')" "main: modifies conflict.txt"
fx_commit main3.txt "main 3" "main: add main3.txt"

# feature: connected to the base. f1 modifies the same line (conflict), f2 adds a file (independent of f1:
# "Skip" f1 leaves exactly 1 commit replayed)
git checkout -q -b feature main~3
fx_commit conflict.txt "$(fx_ligne3 ' (feature)')" "feature: modifies conflict.txt"
fx_commit feature2.txt "feature 2" "feature: adds feature2.txt"

fx_done
