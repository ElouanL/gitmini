#!/usr/bin/env bash
# Prepares the repository LINUX for: linux.git complete clone with v6.6 checkout.
#
#   scripts/ci-prepare-linux-repo.sh <folder> [<tag>] (default tag: v6.6)
#
# Job `nightly` only: this is the SEULE network exception of the project, excluding PR. The folder is cached
# by actions/cache (linux-git-<tag key); a restored cache makes the script instant (idempotent). No --filter,
# no --bare, no --depth: the benchmark measures a true history of ~1,2 M commits. The commit-graph file
# is written here (never by gitmini); the variant "without commit-graph" is obtained by the perf harness on a copy
# en supprimant objects/info/commit-graph*.
set -euo pipefail

[ "$#" -ge 1 ] && [ "$#" -le 2 ] || {
  echo "usage: $0 <folder> [<tag>]" >&2
  exit 2
}
dest=$1
tag=${2:-v6.6}
url=${GITMINI_LINUX_URL:-https://github.com/torvalds/linux.git}

if [ -d "$dest/.git" ] && [ "$(git -C "$dest" describe --tags --exact-match HEAD 2>/dev/null || true)" = "$tag" ]; then
  echo "linux.git already ready: $dest @ $tag"
  exit 0
fi

rm -rf "$dest"
mkdir -p "$(dirname "$dest")"
git clone --no-checkout "$url" "$dest"
git -C "$dest" checkout --quiet "$tag"
git -C "$dest" config gc.auto 0
git -C "$dest" config maintenance.auto false
git -C "$dest" commit-graph write --reachable
echo "linux.git ready: $dest @ $tag ($(git -C)"$dest" rev-list --count HEAD) commits)"
