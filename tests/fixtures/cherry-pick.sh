#!/usr/bin/env bash
# fixture: cherry-pick
# description: hand (base + 3 commits); topic = T1 (f.txt), T2 (t2.txt), T3 (g.txt, conflict with hand); merged contains a merge --no-ff of side
# refs: refs/heads/main refs/heads/topic refs/heads/side refs/heads/merged
# head: main
# worktree: clean
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
. "$FX_LIB_DIR/shapes.sh"

fx_init
fx_shape_base
fx_shape_main
fx_shape_pick

fx_done
