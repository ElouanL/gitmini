#!/usr/bin/env bash
# fixture: stash-multi
# description: 3 stashes on the same HEAD, worktree clean. stash@{0} "wip index" = s1.txt staged AND unstaged; stash@{1} "wip untracked" = with untracked (-u); stash@{2} "wip parser" = changes followed by parser.txt
# refs: refs/heads/main refs/stash
# head: main
# worktree: clean
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

fx_init
fx_write README.md "# Fixture gitmini"
fx_write s1.txt "$(fx_numbered 5 s1)"
fx_write parser.txt "$(fx_numbered 5 parser)"
fx_write lexer.txt "$(fx_numbered 5 lexer)"
fx_commit_all "commit 1: init"
fx_commit notes.txt "notes" "commit 2: adds notes.txt"
fx_commit more.txt "more" "commit 3: adds more.txt"

# stash@{2} (stacked first): change followed by parser.txt
fx_numbered 5 parser | awk 'NR == 2 { print $0 " (wip)"; next } { print }' > parser.txt
fx_stash -m "wip parser"

# stash@{1}: modification followed by lexer.txt + file not followed scratch.txt (-u: 3rd parent of stash)
fx_numbered 5 lexer | awk 'NR == 3 { print $0 " (wip)"; next } { print }' > lexer.txt
fx_write scratch.txt "draft"
fx_stash -u -m "wip untracked"

# stash@{0} (last stacked): s1.txt with an INDEXED modification (line 1) and a non-indexed change (line 4)
fx_numbered 5 s1 | awk 'NR == 1 { print $0 " (staged)"; next } { print }' > s1.txt
git add s1.txt
fx_numbered 5 s1 | awk 'NR == 1 { print $0 " (staged)"; next } NR == 4 { print $0 " (unstaged)"; next } { print }' > s1.txt
fx_stash -m "wip index"

fx_done
