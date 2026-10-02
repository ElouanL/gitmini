#!/usr/bin/env bash
# fixture: untracked-20k
# description: linear + 20,000 untracked files in 200 folders (untracked/dNNN/uNNNNN.txt, 100 per folder)
# refs: refs/heads/main refs/tags/v1.0
# head: main
# worktree: dirty
# heavy: yes
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
. "$FX_LIB_DIR/shapes.sh"

fx_init
fx_shape_linear

d=0
while [ "$d" -lt 200 ]; do
  printf -v dir 'untracked/d%03d' "$d"   # printf -v : pas de subprocess (20 000 fichiers)
  mkdir -p "$dir"
  f=0
  while [ "$f" -lt 100 ]; do
    printf -v name 'u%05d.txt' $((d * 100 + f))
    printf 'non suivi %d/%d\n' "$d" "$f" > "$dir/$name"
    f=$((f + 1))
  done
  d=$((d + 1))
done

fx_done
