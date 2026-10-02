#!/usr/bin/env bash
# fixture: lfs-pointer
# description: .gitattributes (*.bin filter=lfs diff=lfs merge=lfs -text) and a LFS commit pointer (asset.bin), without git-lfs installed or configured
# refs: refs/heads/main
# head: main
# worktree: clean
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

fx_init
fx_commit README.md "# Fixture gitmini" "commit 1: init"
fx_commit .gitattributes "*.bin filter=lfs diff=lfs merge=lfs -text" "commit 2: attributs LFS"
# pointer LFS v1 (spec git-lfs): the actual "content" does not exist anywhere, it is wanted
fx_commit asset.bin "version https://git-lfs.github.com/spec/v1
oid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393
size 12345" "commit 3: adds the pointer LFS asset.bin"

fx_done
