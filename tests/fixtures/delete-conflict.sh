#!/usr/bin/env bash
# fixture: delete-conflict
# description: gone.txt created on the base; hand deletes it; feature (2 commits) modifies it and then adds other.txt; HEAD on feature (conflict deleted-by-us to rebase)
# refs: refs/heads/main refs/heads/feature
# head: feature
# worktree: clean
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

fx_init
fx_write README.md "# Fixture gitmini"
fx_write gone.txt "$(fx_ligne3)"
fx_write keep.txt "keep"
fx_commit_all "base: init"

# main supprime gone.txt
git rm -q gone.txt
tick; git commit -q -m "main: deletes gone.txt"

# feature: modifiess gone.txt (1st commit replayed: conflict "removed by us"), then adds other.txt
git checkout -q -b feature main~1
fx_commit gone.txt "$(fx_ligne3 ' (feature)')" "feature: modifies gone.txt"
fx_commit other.txt "other" "feature: adds other.txt"

fx_done
