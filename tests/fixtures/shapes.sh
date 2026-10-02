# shapes.sh -- history forms shared by multiple fixtures (to be sourced after lib.sh, once `fx_init` is done).
#
#   fx_shape_linear                     linear, detached-head, with-remote, untracked-20k
#   fx_shape_base / _main / _feature    divergent, submodule
#   fx_shape_base / _main / _pick       cherry-pick, submodule
#
# The three "base/hand/feature/pick" forms share f.txt and g.txt: line 2 of g.txt is modified by
# hand ("hand: modifies g.txt") AND by T3 of fixture cherry-pick, which produces the desired conflict.

# 10 commits "commit 1" ... "commit 10" on hand (one file by commit, none changes an existing file:
# All revert is conflict free), annotated tag v1.0 on the 5th.
fx_shape_linear() {
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    fx_commit "file-$i.txt" "content of commit $i" "commit $i"
    if [ "$i" -eq 5 ]; then fx_tag v1.0; fi
  done
}

# Commit de base commun : README.md, f.txt, g.txt.
fx_shape_base() {
  fx_write README.md "# Fixture gitmini"
  fx_write f.txt "$(fx_ligne3)"
  fx_write g.txt "$(fx_ligne3)"
  fx_commit_all "base: init"
}

# 3 commits on hand; 2nd modifies line 2 of g.txt.
fx_shape_main() {
  fx_commit main1.txt "main 1" "main: add main1.txt"
  fx_commit g.txt "$(fx_ligne3 ' (main)')" "main: modifies g.txt"
  fx_commit main3.txt "main 3" "main: add main3.txt"
}

# feature: 4 commits from the base, without conflict with hand.
# feature-ff : en avance stricte de 2 commits sur main (fast-forward possible).
fx_shape_feature() {
  local i
  git checkout -q -b feature main~3
  for i in 1 2 3 4; do fx_commit "feature$i.txt" "feature $i" "feature: adds feature$i.txt"; done
  git checkout -q -b feature-ff main
  for i in 1 2; do fx_commit "ff$i.txt" "ff $i" "feature-ff: adds ff$i.txt"; done
  git checkout -q main
}

# Topic : T1 (modifies f.txt, without conflict, ideal: replayed it becomes empty), T2 (add t2.txt), T3 (modifies the
#   line 2 of g.txt, already modified by hand: conflict); connected to the base.
# side then merged: merged = hand + 1 commit + merge --no-ff side (side = hand + 2 commits).
fx_shape_pick() {
  git checkout -q -b topic main~3
  fx_commit f.txt "$(fx_ligne3 ' (T1)')" "T1: modifies f.txt"
  fx_commit t2.txt "t2" "T2: add t2.txt"
  fx_commit g.txt "$(fx_ligne3 ' (T3)')" "T3: modifies g.txt"
  git checkout -q -b side main
  fx_commit side1.txt "side 1" "side: add side1.txt"
  fx_commit side2.txt "side 2" "side: add side2.txt"
  git checkout -q -b merged main
  fx_commit merged1.txt "merged 1" "merged: add merged1.txt"
  fx_merge side "Merge branch 'side' into merged"
  git checkout -q main
}
