# lib.sh -- common library of fixture scripts.
# To source from a fixture script (after `set -euo pipefail`), never to run.
#
# Provided by the runner (build.sh) :
#   FX_DIR repository work to be created (<fixture>/repo); his brothers (../origin.git, ../other...) are created by scripts
#   FX_HOME empty folder, used as HOME and XDG_CONFIG_HOME
#
# Compatible bash 3.2 (macOS) and bash 5: no associative array, no ${x,,}, no mapfile.
# `set -e` Trap: Never end a function or loop by `[ test ] && commande` (use `if`).

FX_LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# Absolute path of the fixture script that is the source of this library (fx_done reads its header after `cd`).
FX_SCRIPT=$(cd "$(dirname "${BASH_SOURCE[1]}")" && pwd)/$(basename "${BASH_SOURCE[1]}")
. "$FX_LIB_DIR/select-git.sh"
gitmini_select_git || exit 1

: "${FX_DIR:?FX_DIR not set (run fixtures through tests/fixtures/build.sh)}"
: "${FX_HOME:?FX_HOME not set (run fixtures through tests/fixtures/build.sh)}"
mkdir -p "$FX_HOME/.config"

# Deterministic Git environment.
export TZ=UTC LC_ALL=C GIT_CONFIG_NOSYSTEM=1
export HOME="$FX_HOME" XDG_CONFIG_HOME="$FX_HOME/.config"   # FX_HOME = empty folder provided by the runner
export GIT_AUTHOR_NAME="Fixture Bot"  GIT_AUTHOR_EMAIL="bot@fixtures.gitmini"
export GIT_COMMITTER_NAME="Fixture Bot" GIT_COMMITTER_EMAIL="bot@fixtures.gitmini"
FX_T=1700000000                                             # 2023-11-14T22:13:20Z

tick() { FX_T=$((FX_T + 60)); export GIT_AUTHOR_DATE="@$FX_T +0000" GIT_COMMITTER_DATE="@$FX_T +0000"; }

# Nothing but this config should influence git: we remove everything that the environment from the
# A developer or a parent hook could have injected, and then a publisher and an inert pager were fixed.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES \
      GIT_COMMON_DIR GIT_NAMESPACE GIT_CONFIG GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT GIT_CONFIG_GLOBAL \
      GIT_CONFIG_SYSTEM GIT_PREFIX GIT_EXEC_PATH GIT_TEMPLATE_DIR
export GIT_EDITOR=true GIT_PAGER=cat GIT_TERMINAL_PROMPT=0 GIT_MERGE_AUTOEDIT=no
# A `tick` forgetfulness then gives a fixed date (so deterministic) rather than the current time.
export GIT_AUTHOR_DATE="@$FX_T +0000" GIT_COMMITTER_DATE="@$FX_T +0000"

fx_die() { echo "fixture ${FX_NAME:-?}: $*" >&2; exit 1; }

# fx_config_repo [folder] : explicit local config . No argument : the current repository.
fx_config_repo() {
  local d=${1:-.}
  git -C "$d" config init.defaultBranch main
  git -C "$d" config commit.gpgsign false; git -C "$d" config tag.gpgsign false
  git -C "$d" config core.autocrlf false;  git -C "$d" config core.fileMode true
  git -C "$d" config gc.auto 0;            git -C "$d" config maintenance.auto false
}

# fx_init [git init options...]: Creates $FX_DIR (without template: no example hooks or info/excludes) and fits in.
fx_init() {
  git init -q --template= -b main "$@" "$FX_DIR"
  cd "$FX_DIR"
  fx_config_repo
}

fx_commit() {  # fx_commit <chemin> <contenu> <message>
  mkdir -p "$(dirname "$1")"; printf '%s\n' "$2" > "$1"; git add -- "$1"; tick; git commit -q -m "$3"
}
fx_merge()  { tick; git merge -q --no-ff -m "$2" $1; }      # fx_merge "<branches…>" <message>
fx_stash()  { tick; git stash push -q "$@"; }
fx_tag()    { tick; git tag -a "$1" -m "$1"; }
fx_bare_remote() {  # fx_bare_remote <name>: creates $FX_DIR/../<name>.git and removes the branch
  # The URL of the remote is RELATIVE (../<name>.git): the fixture is copied to a tmpdir where <name>.git is
  # the brother of repo/ (, §5.1). An absolute URL would point the copy to the original fixture.
  git init -q --bare --template= -b main "$FX_DIR/../$1.git"
  fx_config_repo "$FX_DIR/../$1.git"
  git -C "$FX_DIR" remote add "$1" "../$1.git"
  # git >= 2.48 creates refs/remotes/<name>/HEAD in fetch, previous versions not: disable it everywhere
  # so that the refs of the fixture does not depend on the git version (unknown key = ignored by the old ones).
  git -C "$FX_DIR" config "remote.$1.followRemoteHEAD" never
  git -C "$FX_DIR" push -q "$1" --all; git -C "$FX_DIR" fetch -q "$1"
}

# Additional helpers.
fx_write() {   # fx_write <path> <content>: writes a file (without indexing or committing)
  mkdir -p "$(dirname "$1")"; printf '%s\n' "$2" > "$1"
}
fx_commit_all() {  # fx_commit_all <message> : indexe tout puis committe
  git add -A; tick; git commit -q -m "$1"
}
fx_numbered() {  # fx_numbered <n> [préfixe] : n lines « <préfixe> 1 » … « <préfixe> n »
  awk -v n="$1" -v p="${2:-line}" 'BEGIN { for (i = 1; i <= n; i++) print p " " i }'
}
fx_ligne3() {  # fx_ligne3 [suffixe] : 3 lines, la 2e porte le suffixe (base des conflits sur « la line 2 »)
  printf 'line 1\nline 2%s\nline 3' "${1:-}"
}
fx_run() { tick; "$@"; }   # fx_run git cherry-pick … : fait avancer l'horloge avant une commande qui crée un commit
fx_clone() {   # fx_clone <nom-du-remote> <folder>: equivalent of `git clone` of a brother $FX_DIR/../<name>.git
  # No `git clone`: it records the absolute URL (config and reflog). Here the URL remains ../<name>.git.
  local d="$FX_DIR/../$2"
  git init -q --template= -b main "$d"
  fx_config_repo "$d"
  git -C "$d" remote add origin "../$1.git"
  git -C "$d" config remote.origin.followRemoteHEAD never   # voir fx_bare_remote
  git -C "$d" fetch -q origin
  git -C "$d" checkout -q -B main --track origin/main
}

# fx_done: Checks the status of the calling script header (`# head:`, `# refs:`, `# worktree:`)
# then print refs (<oid> <refname>) and stash (<tree> <message>) entries.
#   # head:     main | main (unborn) | detached@<rev>
#   # refs: refs patterns separated by spaces (glob `case`, `-` = none); all refs must match exactly
#   # worktree: clean | dirty  (`git status --porcelain --untracked-files=all` vide ou non)
fx_header() { sed -n "s/^# $2:[[:space:]]*//p" "$1" | head -n 1; }

fx_done() {
  local script=$FX_SCRIPT k v
  FX_NAME=$(basename "$script" .sh)
  for k in fixture description refs head worktree; do
    v=$(fx_header "$script" "$k")
    if [ -z "$v" ]; then fx_die "header \"# $k:\" missing in $script"; fi
  done
  [ "$(fx_header "$script" fixture)" = "$FX_NAME" ] || fx_die "\"# fixture:\" does not match script name"
  cd "$FX_DIR"

  local want_head head_sym head_oid
  want_head=$(fx_header "$script" head)
  head_sym=$(git symbolic-ref -q HEAD || true)
  head_oid=$(git rev-parse --verify -q HEAD || true)
  case "$want_head" in
    detached@*)
      [ -z "$head_sym" ] || fx_die "HEAD should be detached, it points to $head_sym"
      [ "$head_oid" = "$(git rev-parse --verify "${want_head#detached@}^{commit}")" ] \
        || fx_die "HEAD seconded to $head_oid, expected ${want_head#detached@}" ;;
    *" (unborn)")
      [ "$head_sym" = "refs/heads/${want_head% (unborn)}" ] || fx_die "HEAD should point to ${want_head% (unborn)} (not born)"
      [ -z "$head_oid" ] || fx_die "HEAD should not be born" ;;
    *)
      [ "$head_sym" = "refs/heads/$want_head" ] || fx_die "HEAD should point to $want_head, it points to '${head_sym:-detached}'"
      [ -n "$head_oid" ] || fx_die "HEAD should not be born" ;;
  esac

  local patterns ref pat matched
  patterns=$(fx_header "$script" refs)
  if [ "$patterns" = "-" ]; then patterns=""; fi   # « # refs: - » : no ref (repository empty)
  set -f   # motifs should not be developed as paths
  while IFS= read -r ref; do
    if [ -z "$ref" ]; then continue; fi
    matched=0
    for pat in $patterns; do
      case "$ref" in $pat) matched=1; break ;; esac
    done
    if [ "$matched" -eq 0 ]; then set +f; fx_die "ref inattendue $ref (non couverte par « # refs: $patterns »)"; fi
  done <<EOF
$(git for-each-ref --format='%(refname)')
EOF
  for pat in $patterns; do
    matched=0
    while IFS= read -r ref; do
      case "$ref" in $pat) matched=1; break ;; esac
    done <<EOF
$(git for-each-ref --format='%(refname)')
EOF
    if [ "$matched" -eq 0 ]; then set +f; fx_die "no ref corresponds to \"$pat\" (# refs:)"; fi
  done
  set +f

  local status
  status=$(git status --porcelain --untracked-files=all)
  case "$(fx_header "$script" worktree)" in
    clean) [ -z "$status" ] || fx_die "worktree announced clean but git status list: $(printf '%s'"$status" | head -n 3 | tr '\n' ' ')" ;;
    dirty) [ -n "$status" ] || fx_die "worktree announced dirty but git status is empty" ;;
    *)     fx_die "\" # worktree:\" must be clean or dirty" ;;
  esac

  echo "== fixture $FX_NAME"
  echo "HEAD ${head_sym:-detached} ${head_oid:-(unborn)}"
  git for-each-ref --format='%(objectname) %(refname)'
  if git rev-parse -q --verify refs/stash >/dev/null; then
    git log -g --format='%gd tree=%T %gs' refs/stash
  fi
}
