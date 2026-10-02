#!/usr/bin/env bash
# fixture: perf-100k-nocg
# description: perf-100k SANS file commit-graph (degraded from: B2 = B3 < 1.5 s)
# refs: refs/heads/* refs/remotes/origin/* refs/tags/*
# head: main
# worktree: clean
# heavy: yes
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

fx_init
"$(gitmini_python)" "$FX_LIB_DIR/gen-perf-100k.py" --repo "$FX_DIR" --no-commit-graph

fx_done
