#!/usr/bin/env bash
# fixture: divergent
# description: common base + 3 commits on hand + 4 on feature (no conflict); feature-ff in strict advance of 2 commits on hand
# refs: refs/heads/main refs/heads/feature refs/heads/feature-ff
# head: main
# worktree: clean
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
. "$FX_LIB_DIR/shapes.sh"

fx_init
fx_shape_base
fx_shape_main
fx_shape_feature

fx_done
