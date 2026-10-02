#!/usr/bin/env bash
# fixture: linear
# description: 10 commits "commit 1" to "commit 10" on hand (a file-N.txt file by commit), annotated tag v1.0 on the 5th
# refs: refs/heads/main refs/tags/v1.0
# head: main
# worktree: clean
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
. "$FX_LIB_DIR/shapes.sh"

fx_init
fx_shape_linear

fx_done
