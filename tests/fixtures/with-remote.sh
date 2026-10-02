#!/usr/bin/env bash
# fixture: with-remote
# description: linear + remote bare origin (.../origin.git); hand follows origin/hand which has 2 commits advance; origin/dev exists; local feature (2 commits) not published; no local branch dev; clone collaborator in ../other
# refs: refs/heads/main refs/heads/feature refs/remotes/origin/main refs/remotes/origin/dev refs/tags/v1.0
# head: main
# worktree: clean
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
. "$FX_LIB_DIR/shapes.sh"

fx_init
fx_shape_linear
fx_bare_remote origin
git push -q origin v1.0
git branch -q --set-upstream-to=origin/main main

# The collaborator (other/) pushes 2 commits on hand and creates dev (1 commit, from the old hand)...
fx_clone origin other
cd "$FX_DIR/../other"
fx_commit origin1.txt "origin 1" "origin: add origin1.txt"
fx_commit origin2.txt "origin 2" "origin: add origin2.txt"
git push -q origin main
git checkout -q -b dev main~2
fx_commit dev.txt "dev" "dev: adds dev.txt"
git push -q origin dev
git checkout -q main

# ...then the repository main fetch: origin/main has 2 commits ahead on hand, origin/dev exists, no local dev.
cd "$FX_DIR"
git fetch -q origin

# feature : local, unpublished, 2 commits above hand
git checkout -q -b feature main
fx_commit feature1.txt "feature 1" "feature: adds feature1.txt"
fx_commit feature2.txt "feature 2" "feature: adds feature2.txt"
git checkout -q main

fx_done
