#!/usr/bin/env bash
# verify.sh -- verifies that the generated fixtures satisfy what the scenarios expect.
#
#   verify.sh [--out DIR] (DIR: default <racin>/target/fixtures; missing fixtures are generated)
#
# Each control works on a COPIE fixture (like preparationFixture / Fixture::load : home/ repo/ origin.git/
# other/ in a tmpdir) and executes real git commands (rebase in conflict, cherry-pick, push --force-with-lease...).
# At the end, the original fixtures must be unchanged: this is proof that the copy is autonomous (URL relative).
# Heavy Fixtures (perf-100k*, untracked-20k): controlled only if already in DIR.
set -uo pipefail

FX_SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$FX_SRC/../.." && pwd)
. "$FX_SRC/select-git.sh"
gitmini_select_git || exit 1
OUT=${GITMINI_FIXTURES_DIR:-$ROOT/target/fixtures}
if [ "${1:-}" = "--out" ]; then OUT=$2; fi
bash "$FX_SRC/build.sh" --out "$OUT" > /dev/null || exit 1
OUT=$(cd "$OUT" && pwd)
PY=$(gitmini_python)

WORK=$(mktemp -d "${TMPDIR:-/tmp}/gitmini-verify.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
PASS=0; FAILN=0

# instant fixtures of origin (refs + stashes) before handling
mkdir -p "$WORK/snap"
for n in $(ls "$OUT" | grep -v '^\.'); do
  case "$n" in perf-100k*|untracked-20k) continue ;; esac
  [ -d "$OUT/$n" ] && $PY "$FX_SRC/manifest.py" snapshot --git "$GITMINI_TEST_GIT" "$OUT/$n" > "$WORK/snap/$n.json"
done

# --- environnement de test commun  ---
export TZ=UTC LC_ALL=C GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never GIT_EDITOR=true GIT_PAGER=cat
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
export GIT_AUTHOR_DATE="@1800000000 +0000" GIT_COMMITTER_DATE="@1800000000 +0000"

t() {   # t <description> <command...>: success if command succeeds
  local desc=$1; shift
  if "$@" >/dev/null 2>&1; then PASS=$((PASS + 1)); else FAILN=$((FAILN + 1)); echo "FAILED: $desc"; fi
}
eq() {  # eq < description> < expected> < obtained>
  if [ "$2" = "$3" ]; then PASS=$((PASS + 1)); else FAILN=$((FAILN + 1)); echo "FAILED: $1: Expected \"$2\" gets \"$3\""; fi
}

N=0
copy() {  # copy <fixture>: copy in $WORK/<n>/{home,repo,…} and position HOME, R (repo); cd in repo
  N=$((N + 1)); local d="$WORK/$N"
  mkdir -p "$d/home"
  cp -R "$OUT/$1/." "$d/"
  rm -f "$d/.fixture-hash"
  printf '[user]\n\tname = Fixture Bot\n\temail = bot@fixtures.gitmini\n[protocol "file"]\n\tallow = always\n' > "$d/home/.gitconfig"
  export HOME="$d/home" XDG_CONFIG_HOME="$d/home/.config"
  D=$d; R="$d/repo"
  cd "$R"
}
rc() { "$@" >/dev/null 2>&1; echo $?; }

copy empty
t "empty: HEAD not born" bash -c '! git rev-parse -q --verify HEAD'
eq "empty: no ref" "" "$(git for-each-ref)"

copy linear
eq "linear: 10 commits" 10 "$(git rev-list --count HEAD)"
eq "linear: annotated v1.0" tag "$(git cat-file -t refs/tags/v1.0)"
eq "linear: v1.0 sur le 5e commit" "commit 5" "$(git log -1 --format=%s 'v1.0^{commit}')"
eq "linear: grep 'commit 7' -> 1 result" 1 "$(git log --format=%H --grep='commit 7' | wc -l | tr -d ' ')"
eq "linear: auteur" "Fixture Bot" "$(git log -1 --format=%an HEAD~3)"
eq "linear: revert HEAD~3 without conflict" 0 "$(rc git revert --no-edit HEAD~3)"
eq "linear: revert HEAD~1 (then HEAD~3) without conflict" 0 "$(rc git revert --no-edit HEAD~3)"
eq "linear: identity is not in the local config" "" "$(git config --local user.email || true)"

copy detached-head
t "detached-head: HEAD detached" bash -c '! git symbolic-ref -q HEAD'
eq "detached-head: sur le 7e commit" "commit 7" "$(git log -1 --format=%s HEAD)"

copy divergent
eq "divergent: 3 commits sur main" 3 "$(git rev-list --count feature..main)"
eq "divergent: 4 commits sur feature" 4 "$(git rev-list --count main..feature)"
eq "divergent: feature-ff = main + 2" "2 0" "$(git rev-list --left-right --count feature-ff...main | awk '{print $1, $2}')"
t "divergent: feature-ff fast-forward" git merge-base --is-ancestor main feature-ff
eq "diverging: bord -d feature refused (not merged)" 1 "$(rc git branch -d feature)"
eq "divergent: merge ff de feature-ff" 0 "$(rc git merge --ff-only feature-ff)"
t "diverging: merge --ff-only feature impossible (diverged)" bash -c '! git merge --ff-only feature'
eq "divergent: merge --no-ff feature without conflict" 0 "$(rc git merge --no-ff -m m feature)"
eq "divergent: 2 parents" 3 "$(git rev-list --parents -n1 main | wc -w | tr -d ' ')"
copy divergent
git checkout -q feature
eq "diverging: rebase feature on hand without conflict" 0 "$(rc git rebase main)"
eq "divergent: after rebase, merge-base = hand" "$(git rev-parse main)" "$(git merge-base feature main)"
eq "divergent: subjects kept in order" "feature: adds feature1.txt,feature: adds feature2.txt,feature: adds feature3.txt,feature: adds feature4.txt" "$(git log --reverse --format=%s main..feature | tr '\n' ',' | sed 's/,$//')"
copy divergent
git checkout -q feature; echo "ajout" >> README.md
t "diverge: README.md modified uncommitted blocks rebase" bash -c '! git rebase main'
eq "divergent: rebase --autostash passes with modified README.md" 0 "$(rc git rebase --autostash main)"
eq "diverging: modified README.md retained after autostash" " M README.md" "$(git status --porcelain)"

copy rebase-conflict
eq "rebase-conflict: HEAD sur feature" refs/heads/feature "$(git symbolic-ref HEAD)"
eq "rebase-conflict: 3 commits sur main, 2 sur feature" "3 2" "$(git rev-list --count main...feature --left-right | awk '{print $1, $2}')"
O=$(git rev-parse feature)
eq "rebase-conflict: rebase en conflit" 1 "$(rc git rebase main)"
eq "rebase-conflict: file in conflict = conflict.txt" conflict.txt "$(git diff --name-only --diff-filter=U)"
eq "rebase-conflict: rebase-merge present" yes "$([ -d "$(git rev-parse --absolute-git-dir)/rebase-merge" ] && echo yes)"
eq "rebase-conflict: step 1 / total 2" "1 2" "$(cat "$(git rev-parse --absolute-git-dir)/rebase-merge/msgnum") $(cat "$(git rev-parse --absolute-git-dir)/rebase-merge/end")"
eq "rebase-conflict: --skip finishes with 1 commit replayed" 0 "$(rc git rebase --skip)"
eq "rebase-conflict: 1 commit replayed" 1 "$(git rev-list --count main..feature)"
copy rebase-conflict
git rebase main >/dev/null 2>&1; printf 'line 1\nline 2 (resolved)\nline 3\n' > conflict.txt; git add conflict.txt
eq "rebase-conflict: Continues after resolution" 0 "$(GIT_EDITOR=true rc git rebase --continue)"
eq "rebase-conflict: 2 commits replayed" 2 "$(git rev-list --count main..feature)"
eq "rebase-conflict: feature~1:conflict.txt solved" "line 2 (resolved)" "$(git show feature~1:conflict.txt | sed -n 2p)"
copy rebase-conflict
git checkout -q main
eq "rebase-conflict: merge feature in hand in conflict" 1 "$(rc git merge --ff feature)"
t "rebase-conflict: MERGE_HEAD present" test -f "$(git rev-parse --absolute-git-dir)/MERGE_HEAD"
eq "rebase-conflict: conflict.txt en conflit" conflict.txt "$(git diff --name-only --diff-filter=U)"

copy rebase-interactive
eq "rebase-interactive: sujets" "A: adds a.txt,B: typo,C: adds c.txt,fixup! A: add a.txt,D: adds d.txt" "$(git log --reverse --format=%s main..feature | tr '\n' ',' | sed 's/,$//')"
TREE=$(git rev-parse 'feature^{tree}')
oid() { git log --format=%H -1 "--grep=^$1" feature; }
A=$(oid 'A:'); B=$(oid 'B:'); C=$(oid 'C:'); F=$(oid 'fixup! A:'); Dd=$(oid 'D:')
printf 'pick %s\nfixup %s\nsquash %s\npick %s\nreword %s\n' "$A" "$F" "$B" "$Dd" "$C" > "$WORK/todo"
cat > "$WORK/seq.sh" <<EOF
#!/bin/sh
cp "$WORK/todo" "\$1"
EOF
cat > "$WORK/ed.sh" <<'EOF'
#!/bin/sh
case "$(head -n1 "$1")" in
  "C: adds c.txt") printf 'C: adds c.txt (renamed)\n' > "$1" ;;
  *) printf 'A: adds a.txt\n\nIncludes the correction B.\n' > "$1" ;;
esac
EOF
chmod +x "$WORK/seq.sh" "$WORK/ed.sh"
eq "rebase-interactive: squash/fixup/reorder/reword without conflict" 0 "$(GIT_SEQUENCE_EDITOR="$WORK/seq.sh" GIT_EDITOR="$WORK/ed.sh" rc git rebase -i main)"
eq "rebase-interactive: 3 commits above de main" "C: adds c.txt (renamed),D: adds d.txt,A: adds a.txt" "$(git log --format=%s main..feature | tr '\n' ',' | sed 's/,$//')"
eq "rebase-interactive: arbre final identique" "$TREE" "$(git rev-parse 'feature^{tree}')"

copy delete-conflict
eq "delete-conflict: HEAD sur feature" refs/heads/feature "$(git symbolic-ref HEAD)"
eq "delete-conflict: rebase en conflit" 1 "$(rc git rebase main)"
eq "delete-conflict: gone.txt deleted by us (DU)" "DU gone.txt" "$(git status --porcelain | grep gone.txt)"
rm gone.txt; git add -A --pathspec-from-file=- --pathspec-file-nul < <(printf 'gone.txt\0') 2>/dev/null
eq "delete-conflict: continuous after deletion" 0 "$(GIT_EDITOR=true rc git rebase --continue)"
eq "delete-conflict: gone.txt absent de feature" "" "$(git ls-tree -r feature -- gone.txt)"
eq "delete-conflict: other.txt present" other.txt "$(git ls-tree -r --name-only feature -- other.txt)"

copy dirty-worktree
eq "dirty-worktree: 3 hunks in mod.txt" 3 "$(git diff -U3 -- mod.txt | grep -c '^@@')"
ST=$(git status --porcelain=v2 -z --untracked-files=all | tr '\0' '\n')
for e in "1 .M N... 100644 100644 100644 .* big.txt" "1 .M N... 100644 100644 100644 .* crlf.txt" "1 .D N... 100644 100644 000000 .* del.txt" \
         "1 .M N... 100644 100644 100644 .* image.png" "1 .M N... 100644 100644 100644 .* mod.txt" "2 R. N... 100644 100644 100644 .* R100 new.txt" \
         "1 M. N... 100644 100644 100644 .* staged.txt" "^? untracked.txt" "^? dir avec espace/é.txt"; do
  t "dirty-worktree: statut « $e »" bash -c 'printf "%s\n" "$1" | grep -q -- "$2"' _ "$ST" "$e"
done
eq "dirty-worktree: old.txt is the source of the rename" old.txt "$(printf '%s\n' "$ST" | sed -n '/^2 R\./{n;p;}')"
eq "dirty-worktree: 9 entries" 10 "$(printf '%s\n' "$ST" | wc -l | tr -d ' ')"
eq "dirty-worktree: big.txt >= 6 Mio" yes "$([ "$(wc -c < big.txt | tr -d ' ')" -ge 6291456 ] && echo yes)"
eq "dirty-worktree: image.png 1 024 octets binaire" "1024 binary" "$(wc -c < image.png | tr -d ' ') $(git diff --numstat -- image.png | awk '{ if ($1 == "-") print "binary" }')"
eq "dirty-worktree: crlf.txt keeps its CRLF (2 lines modified)" "2 5" "$(git diff --numstat -- crlf.txt | awk '{print $1}') $(grep -c $'\r$' crlf.txt)"
eq "dirty-worktree: stash -u laisse un worktree propre" "" "$(git stash push -q -u && git status --porcelain --untracked-files=all)"
t "dirty-worktree: stash@{0}^3 existe (non suivis)" git rev-parse -q --verify 'stash@{0}^3'
copy dirty-worktree
git reset -q
eq "dirty-worktree: git reset unindexes everything" "" "$(git diff --cached --name-only)"

copy stash-multi
eq "stash-multi: 3 entries" "On main: wip index|On main: wip untracked|On main: wip parser" "$(git stash list --format=%gs | tr '\n' '|' | sed 's/|$//')"
t "stash-multi: stash@{1} a un 3e parent (-u)" git rev-parse -q --verify 'stash@{1}^3'
t "stash-multi: stash@{0} has a separate index to the worktree" bash -c '! git diff --quiet "stash@{0}^2" "stash@{0}"'
eq "stash-multi: index of stash@{0} = line 1 only" "s1 1 (staged)" "$(git show 'stash@{0}^2:s1.txt' | sed -n 1p)"
eq "stash-multi: apply --index of stash@{0} succeeds" 0 "$(rc git stash apply --index 'stash@{0}')"
copy stash-multi
eq "stash-multi: stash branch from-stash (stash@{2})" 0 "$(rc git stash branch from-stash 'stash@{2}')"
eq "stash-multi: 2 stashes restants" 2 "$(git stash list | wc -l | tr -d ' ')"
copy stash-multi
H=$(git rev-parse 'stash@{2}'); git stash drop -q 'stash@{0}'
eq "stash-multi: after drop of stash@{0}, wip parser is stash@{1}" "$H" "$(git rev-parse 'stash@{1}')"

copy stash-conflict
eq "stash-conflict: apply en conflit" 1 "$(rc git stash apply)"
eq "stash-conflict: s.txt en conflit" s.txt "$(git diff --name-only --diff-filter=U)"
eq "stash-conflict: entry remains" 1 "$(git stash list | wc -l | tr -d ' ')"

copy cherry-pick
T1=$(git rev-parse topic~2); T2=$(git rev-parse topic~1); T3=$(git rev-parse topic)
eq "cherry-pick: sujets de topic" "T1: modifies f.txt|T2: add t2.txt|T3: modifies g.txt" "$(git log --reverse --format=%s main..topic | tr '\n' '|' | sed 's/|$//')"
eq "cherry-pick: T1 T2 without conflict" 0 "$(rc git cherry-pick "$T1" "$T2")"
eq "cherry-pick: log -2" "T2: add t2.txt|T1: modifies f.txt" "$(git log -2 --format=%s | tr '\n' '|' | sed 's/|$//')"
eq "cherry-pick: OID differs from original" 2 "$(git rev-parse HEAD HEAD~1 | grep -vc -e "$T1" -e "$T2")"
copy cherry-pick
eq "cherry-pick (CP-05): T1 alone succeeds" 0 "$(rc git cherry-pick "$T1")"
eq "cherry-pick (CP-05): T1 then T2 : T1 is empty, stop" 1 "$(rc git cherry-pick "$T1" "$T2")"
t "cherry-pick (CP-05): CHERRY_PICK_HEAD present (empty)" test -f "$(git rev-parse --absolute-git-dir)/CHERRY_PICK_HEAD"
eq "cherry-pick (CP-05): --skip applique T2" 0 "$(rc git cherry-pick --skip)"
eq "cherry-pick (CP-05): T2 applied" "T2: add t2.txt" "$(git log -1 --format=%s)"
t "cherry-pick (CP-05): sequencer deleted" test ! -e "$(git rev-parse --absolute-git-dir)/sequencer"
copy cherry-pick
eq "cherry-pick: T3 en conflit" 1 "$(rc git cherry-pick "$T3")"
eq "cherry-pick: conflit sur g.txt" g.txt "$(git diff --name-only --diff-filter=U)"
eq "cherry-pick: abort" 0 "$(rc git cherry-pick --abort)"
copy cherry-pick
eq "cherry-pick externe T1 T3 T2 : conflit sur T3" 1 "$(rc git cherry-pick "$T1" "$T3" "$T2")"
eq "External cherry-pick: remains T3 (current) and T2 in todo, T1 applied" "2 T1: modifies f.txt" "$(grep -c . "$(git rev-parse --absolute-git-dir)/sequencer/todo" | tr -d ' ') $(git log -1 --format=%s)"
eq "cherry-pick externe : --skip applique T2" 0 "$(rc git cherry-pick --skip)"
eq "External cherry-pick: T2 applied" "T2: add t2.txt" "$(git log -1 --format=%s)"
copy cherry-pick
M=$(git rev-parse merged)
eq "cherry-pick: merged = merge --no-ff de side (2 parents)" 3 "$(git rev-list --parents -n1 merged | wc -w | tr -d ' ')"
eq "cherry-pick: cherry-pick -m 1 -x of the merge" 0 "$(rc git cherry-pick -m 1 -x "$M")"
t "cherry-pick: message -x" bash -c "git log -1 --format=%B | grep -q '(cherry picked from commit $M)'"
eq "cherry-pick: new commit to 1 parent" 2 "$(git rev-list --parents -n1 HEAD | wc -w | tr -d ' ')"
copy cherry-pick
git checkout -q merged
eq "cherry-pick: revert -m 1 of the merge on merged" 0 "$(rc git revert -m 1 --no-edit "$M")"
t "cherry-pick: le revert supprime side1.txt" test ! -e side1.txt

copy octopus
eq "octopus: 4 parents" 5 "$(git rev-list --parents -n1 main | wc -w | tr -d ' ')"
eq "octopus: 3 merges au total (2 classiques + 1 octopus)" 3 "$(git rev-list --merges --count main)"
eq "octopus: gh-pages orpheline" "" "$(git merge-base main gh-pages || true)"
eq "octopus: gh-pages single root" 1 "$(git rev-list --count gh-pages)"
eq "octopus: rev-list --all inclut gh-pages" 1 "$(git rev-list --all | grep -c "$(git rev-parse gh-pages)")"

copy with-remote
eq "with-remote: main suit origin/main" origin/main "$(git rev-parse --abbrev-ref 'main@{u}')"
eq "with-remote: origin/main a 2 commits d'avance" 2 "$(git rev-list --count main..origin/main)"
eq "with-remote: origin/dev existe" yes "$(git rev-parse -q --verify refs/remotes/origin/dev >/dev/null && echo yes)"
eq "with-remote: no local branch dev" "" "$(git branch --list dev)"
eq "with-remote: feature without upstream" "" "$(git rev-parse --abbrev-ref 'feature@{u}' 2>/dev/null || true)"
eq "with-remote: URL de origin relative" "../origin.git" "$(git remote get-url origin)"
eq "with-remote: the bare of the COPIE is used" "$(git rev-parse origin/main)" "$(git -C ../origin.git rev-parse main)"
eq "with-remote: other pointe sur ../origin.git" "../origin.git" "$(git -C ../other remote get-url origin)"
eq "with-remote: pas de refs/remotes/origin/HEAD" "" "$(git for-each-ref refs/remotes/origin/HEAD)"
eq "with-remote: pull --ff-only" 0 "$(rc git merge --ff-only origin/main)"
copy with-remote
git commit -q --allow-empty -m "local"
eq "with-remote: push not fast-forward rejected" 1 "$(rc git push origin main)"
eq "Feature with-remote: push (unpublished)" 0 "$(rc git push -u origin feature)"
copy with-remote
git -C ../other fetch -q origin
eq "with-remote: other suit origin/main" "$(git rev-parse origin/main)" "$(git -C ../other rev-parse main)"

copy push-lease
eq "push-lease: topic ahead 1 behind 1" "1 1" "$(git rev-list --left-right --count topic...origin/topic | awk '{print $1, $2}')"
eq "push-lease: HEAD sur topic" refs/heads/topic "$(git symbolic-ref HEAD)"
t "push-lease: the actual remote is ahead of local origin/topic" bash -c '[ "$(git ls-remote origin refs/heads/topic | cut -f1)" != "$(git rev-parse origin/topic)" ]'
eq "push-lease: force-with-lease rejected (stale)" 1 "$(rc git push --force-with-lease --force-if-includes origin refs/heads/topic:refs/heads/topic)"
t "push-lease: message stale info" bash -c 'git push --force-with-lease --force-if-includes origin refs/heads/topic:refs/heads/topic 2>&1 | grep -q "stale info"'
eq "push-lease: fetch then rebase on origin/topic without conflict" 0 "$(git fetch -q origin; rc git rebase origin/topic)"
eq "push-lease: after rebase ahead 1 ahead 0" "1 0" "$(git rev-list --left-right --count topic...origin/topic | awk '{print $1, $2}')"
eq "push-lease: push succeeds" 0 "$(rc git push --force-with-lease --force-if-includes origin refs/heads/topic:refs/heads/topic)"

copy submodule
eq "submodule: lib offset" " M lib" "$(git status --porcelain)"
t "submodule: git submodule status reports the offset (+)" bash -c 'git submodule status | grep -q "^+"'
eq "submodule: URL of the relative submodule" "../lib.git" "$(git config submodule.lib.url)"
git checkout -q feature
eq "Submodule: rebase feature on hand passes with lib offset" 0 "$(rc git rebase main)"
copy submodule
eq "submodule: cherry-pick T1 T2 passes with offset lib" 0 "$(rc git cherry-pick topic~2 topic~1)"
eq "submodule: same branches as diverge + cherry-pick" "feature|feature-ff|main|merged|side|topic" "$(git for-each-ref --format='%(refname:short)' refs/heads | tr '\n' '|' | sed 's/|$//')"

copy lfs-pointer
eq "lfs-pointer: attributs" "*.bin filter=lfs diff=lfs merge=lfs -text" "$(cat .gitattributes)"
eq "lfs-pointer: pointeur v1" "version https://git-lfs.github.com/spec/v1" "$(head -n1 asset.bin)"
t "lfs-pointer: git-lfs not configured" bash -c '! git config --get filter.lfs.clean'
eq "lfs-pointer: worktree propre" "" "$(git status --porcelain)"

copy sha256
eq "sha256: format d'objet" sha256 "$(git rev-parse --show-object-format)"
eq "sha256: 64 character OID" 64 "$(git rev-parse HEAD | tr -d '\n' | wc -c | tr -d ' ')"

# --- heavy fixtures, if already generated ---
if [ -d "$OUT/untracked-20k" ]; then
  copy untracked-20k
  eq "untracked-20k: 20 000 fichiers untracked" 20000 "$(git ls-files -o --exclude-standard | wc -l | tr -d ' ')"
  eq "untracked-20k: 200 dossiers" 200 "$(git ls-files -o --exclude-standard | sed 's|/[^/]*$||' | sort -u | wc -l | tr -d ' ')"
fi
for v in perf-100k perf-100k-nocg perf-100k-dirty; do
  if [ -d "$OUT/$v" ]; then
    copy "$v"
    eq "$v: 100 000 commits" 100000 "$(git rev-list --all --count)"
    eq "$v: 1 000 merges" 1000 "$(git rev-list --all --merges --count)"
    eq "$v: 300 branches" 300 "$(git for-each-ref refs/heads | wc -l | tr -d ' ')"
    eq "$v: 30 tags" 30 "$(git for-each-ref refs/tags | wc -l | tr -d ' ')"
    eq "$v: 5 000 fichiers suivis" 5000 "$(git ls-files | wc -l | tr -d ' ')"
    eq "$v: 300 upstreams" 300 "$(git for-each-ref --format='%(upstream)' refs/heads | grep -c .)"
    case "$v" in
      perf-100k-nocg) eq "$v: without commit-graph" "" "$(ls .git/objects/info/commit-graph* 2>/dev/null)" ;;
      *) t "$v: commit-graph writes" test -f .git/objects/info/commit-graph ;;
    esac
    case "$v" in
      perf-100k-dirty)
        eq "$v: 1,000 files followed modified" 1000 "$(git diff --name-only | wc -l | tr -d ' ')"
        eq "$v: 20,000 not tracked in 200 files" "20000 200" "$(git ls-files -o --exclude-standard | wc -l | tr -d ' ') $(git ls-files -o --exclude-standard | sed 's|/[^/]*$||' | sort -u | wc -l | tr -d ' ')" ;;
      *) eq "$v: worktree propre" "" "$(git status --porcelain)" ;;
    esac
  fi
done

# --- original fixtures have not moved: copies are standalone (no absolute URL to original) ---
cd "$ROOT"
BAD=0
for f in "$WORK"/snap/*.json; do
  n=$(basename "$f" .json)
  $PY "$FX_SRC/manifest.py" snapshot --git "$GITMINI_TEST_GIT" "$OUT/$n" > "$WORK/after.json"
  if ! cmp -s "$f" "$WORK/after.json"; then BAD=1; echo "FAILED: original fixture modified by manipulations on its copies: $n"; fi
done
if [ "$BAD" -eq 1 ]; then FAILN=$((FAILN + 1)); else PASS=$((PASS + 1)); fi

echo "verify: $PASS passed controls, $FAILN failed"
[ "$FAILN" -eq 0 ]
