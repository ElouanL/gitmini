#!/usr/bin/env bash
# fixture: sha256
# description: repository in object format SHA-256 (git init --object-format=sha256) with 1 commit
# refs: refs/heads/main
# head: main
# worktree: clean
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

fx_init --object-format=sha256
fx_commit README.md "# Fixture gitmini (sha256)" "initial commit"

fx_done
