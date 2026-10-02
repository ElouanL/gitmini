#!/usr/bin/env bash
# fixture: perf-100k
# description: FX-100K : 100 000 commits, 300 branches (each with a upstream origin/*), 1000 merges, 30 tags, 5,000 files; commit-graph writes; worktree own
# refs: refs/heads/* refs/remotes/origin/* refs/tags/*
# head: main
# worktree: clean
# heavy: yes
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

fx_init
"$(gitmini_python)" "$FX_LIB_DIR/gen-perf-100k.py" --repo "$FX_DIR"

fx_done
