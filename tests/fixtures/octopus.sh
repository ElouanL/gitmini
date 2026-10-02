#!/usr/bin/env bash
# fixture: octopus
# description: Hand with 2 classic merges (feat-x, feat-y) then an octapus a, b and c merge (4 parents), and an orphan branch gh-pages
# refs: refs/heads/main refs/heads/feat-x refs/heads/feat-y refs/heads/a refs/heads/b refs/heads/c refs/heads/gh-pages
# head: main
# worktree: clean
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

fx_init
fx_commit README.md "# Fixture gitmini" "init"

# merge classique n°1 : feat-x
fx_commit main1.txt "main 1" "main: add main1.txt"
git checkout -q -b feat-x main~1
fx_commit x.txt "x" "feat-x: adds x.txt"
git checkout -q main
fx_merge feat-x "Merge branch 'feat-x'"

# merge classique n°2 : feat-y (2 commits)
fx_commit main2.txt "main 2" "Hand: add hand2.txt"
git checkout -q -b feat-y main~1
fx_commit y1.txt "y1" "feat-y: adds y1.txt"
fx_commit y2.txt "y2" "feat-y: adds y2.txt"
git checkout -q main
fx_merge feat-y "Merge branch 'feat-y'"

# three independent branches (disjointed files) from the same handpoint, then a commit on hand:
# the merge is not a fast-forward and the octapus strategy applies
git checkout -q -b a main
fx_commit a1.txt "a1" "a: adds a1.txt"
git checkout -q -b b main
fx_commit b1.txt "b1" "b: add b1.txt"
fx_commit b2.txt "b2" "b: add b2.txt"
git checkout -q -b c main
fx_commit c1.txt "c1" "c: add c1.txt"
git checkout -q main
fx_commit main3.txt "main 3" "main: add main3.txt"
fx_merge "a b c" "Merge branches 'a', 'b' et 'c' (octopus)"

# orphan branch: no common ancestry with hand
git checkout -q --orphan gh-pages
git rm -rq --cached .
git clean -fdq
fx_commit index.html "<h1>gitmini</h1>" "gh-pages: init"
git checkout -q main

fx_done
