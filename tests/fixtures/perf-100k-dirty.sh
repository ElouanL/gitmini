#!/usr/bin/env bash
# fixture: perf-100k-dirty
# description: FX-100K-DIRTY: perf-100k + 1000 modified tracked files + 20,000 untracked files distributed in 200 folders
# refs: refs/heads/* refs/remotes/origin/* refs/tags/*
# head: main
# worktree: dirty
# heavy: yes
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

fx_init
"$(gitmini_python)" "$FX_LIB_DIR/gen-perf-100k.py" --repo "$FX_DIR" --dirty

fx_done
