#!/usr/bin/env bash
# fixture: detached-head
# description: Linear with HEAD detached on the 7th commit (commit 7 = hand~3)
# refs: refs/heads/main refs/tags/v1.0
# head: detached@main~3
# worktree: clean
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
. "$FX_LIB_DIR/shapes.sh"

fx_init
fx_shape_linear
git checkout -q --detach main~3

fx_done
