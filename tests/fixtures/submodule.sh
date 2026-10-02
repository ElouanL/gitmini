#!/usr/bin/env bash
# fixture: submodule
# description: submodule lib/ (local bar ../lib.git) whose checkout is shifted from a registered gitlink to a commit; otherwise diverge + cherry-pick (main, feature, feature-ff, topic, side, merged)
# refs: refs/heads/main refs/heads/feature refs/heads/feature-ff refs/heads/topic refs/heads/side refs/heads/merged
# head: main
# worktree: dirty
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
. "$FX_LIB_DIR/shapes.sh"

# git >= 2.38.1 refuses file transport for submodules: allowed in the HOME disposable fixture
# (no `git -c`, )
git config --global protocol.file.allow always

fx_init

# Deposition of submodule: bare ../lib.git, initiated from a repository scratch off fixture (in FX_HOME).
git init -q --bare --template= -b main "$FX_DIR/../lib.git"
fx_config_repo "$FX_DIR/../lib.git"
SEED="$FX_HOME/lib-seed"
git init -q --template= -b main "$SEED"
fx_config_repo "$SEED"
cd "$SEED"
fx_commit lib.txt "lib 1" "lib: init"
git remote add origin "$FX_DIR/../lib.git"
git push -q origin main
cd "$FX_DIR"

# Root commit: add submodule (gitlink = "lib: init"). The URL is relative to the main repository.
git submodule add -q ../lib.git lib
git config submodule.lib.url ../lib.git            # relative also in .git/config (fixture is moved)
git -C lib config init.defaultBranch main
fx_config_repo lib
git -C lib remote set-url origin ../../lib.git     # on lib/: repo/lib -> ../../lib.git
tick; git commit -q -m "base: add the submodule lib"

# Same history as diverging + cherry-pick, par-dessus the commit of the submodule
fx_shape_base
fx_shape_main
fx_shape_feature
fx_shape_pick

# Defaling: a new commit DANS the submodule, not registered in the main restitory
cd lib
fx_commit lib.txt "lib 2" "lib: second commit"
cd "$FX_DIR"

fx_done
