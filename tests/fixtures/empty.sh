#!/usr/bin/env bash
# fixture: empty
# description: git init, none commit (HEAD not born on hand)
# refs: -
# head: main (unborn)
# worktree: clean
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

fx_init

fx_done
