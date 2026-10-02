#!/usr/bin/env bash
# fixture: push-lease
# description: topic published (origin/topic) then rewritten locally (amend that adds topic2.txt); AFTER the last local fetch, other pushed a commit on origin/topic (the actual remote is ahead of local origin/topic). HEAD on topic: ahead 1, behind 1
# refs: refs/heads/main refs/heads/topic refs/remotes/origin/main refs/remotes/origin/topic
# head: topic
# worktree: clean
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

fx_init
fx_commit README.md "# Fixture gitmini" "commit 1: init"
fx_commit file-2.txt "2" "commit 2"
fx_commit file-3.txt "3" "commit 3"

# topic : 1 commit published
git checkout -q -b topic
fx_commit topic.txt "topic" "topic: add topic.txt"
fx_bare_remote origin
git branch -q --set-upstream-to=origin/main main
git branch -q --set-upstream-to=origin/topic topic

# the employee pushes a commit on origin/topic; the restitory hand NE refetch PAS
fx_clone origin other
cd "$FX_DIR/../other"
git checkout -q -b topic --track origin/topic
fx_commit collab.txt "collab" "collab: add collab.txt"
git push -q origin topic

# local rewrite: amend that AJOUTE a file (the patch changes, a rebase on origin/topic will replay the commit without conflict)
cd "$FX_DIR"
fx_write topic2.txt "topic 2"
git add topic2.txt
tick; git commit -q --amend --no-edit

fx_done
