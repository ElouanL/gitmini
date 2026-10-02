#!/usr/bin/env bash
# fixture: dirty-worktree
# description: 3 commits on hand, then mod.txt modified (3 hunks), staged.txt modified and staged, del.txt deleted, old.txt renamed in new.txt (staged), untracked.txt and "dir avec space/e.txt" not tracked, image.png (1 KB) and big.txt (6 MB) and crlf.txt (CRLF) modified
# refs: refs/heads/main
# head: main
# worktree: dirty
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

fx_init

# --- commit 1 : text files ---
fx_write README.md "# Fixture gitmini"
fx_write mod.txt "$(fx_numbered 40)"          # 40 lines: Change lines 4, 20 and 36 gives 3 separate hunks (U3)
fx_write del.txt "$(fx_numbered 5 deleted)"
fx_write old.txt "$(fx_numbered 20 old)"   # enough content for git to detect renaming
fx_commit_all "commit 1: text files"

# --- commit 2 : staged.txt and crlf.txt (end of line CRLF committed as : core.autocrlf=false) ---
fx_write staged.txt "$(fx_numbered 10 staged)"
printf 'line 1\r\nline 2\r\nline 3\r\nline 4\r\nline 5\r\n' > crlf.txt
fx_commit_all "commit 2: staged.txt and crlf.txt"

# --- commit 3 : image.png (1 024 bytes, binary : NUL present) and big.txt (6 MiB, 87 382 lines of 72 bytes) ---
{ printf '\211PNG\r\n\032\n'; head -c 1016 /dev/zero; } > image.png
awk 'BEGIN { for (i = 1; i <= 87382; i++) printf "line %06d lorem ipsum dolor sit amet consectetur adipiscing elit 0000\n", i }' > big.txt
fx_commit_all "commit 3: image.png and big.txt"

# --- dirty state ---
# mod.txt : 3 hunks, unstaged
fx_numbered 40 | awk 'NR == 4 || NR == 20 || NR == 36 { print $0 " (modified)"; next } { print }' > mod.txt.new && mv mod.txt.new mod.txt
# staged.txt : modified then staged
fx_numbered 10 staged | awk 'NR== 3 { print $0 " (staged)"; next } { print }' > staged.txt
git add staged.txt
# del.txt: deleted in worktree (unstaged)
rm del.txt
# old.txt -> new.txt : rename staged
git mv old.txt new.txt
# untracked
printf 'untracked content\n' > untracked.txt
mkdir -p "dir avec espace"
printf 'Unicode content\n' > "dir avec espace/$(printf '\303\251').txt"   # e in NFC (U+00E9)
# image.png: modified, still binary (NUL present) and 1,024 bytes
{ printf '\211PNG\r\n\032\n'; head -c 8 /dev/zero; head -c 1008 /dev/zero | tr '\000' '\252'; } > image.png
# big.txt: modified (lines 100 and 80000), still ~6 MiB
awk 'NR == 100 || NR == 80000 { print $0 " MODIFIED"; next } { print }' big.txt > big.txt.new && mv big.txt.new big.txt
# crlf.txt: only lines 2 and 4 change, line ends remain CRLF
printf 'line 1\r\nline 2 modified\r\nline 3\r\nline 4 modified\r\nline 5\r\n' > crlf.txt

fx_done
