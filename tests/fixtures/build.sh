#!/usr/bin/env bash
# build.sh -- generates test fixtures: a fixture-deterministic shell script.
#
#   build.sh [options] [nom…]
#
#   (unnamed) all light fixtures; heavy ones (# heavy: yes: untracked-20k, perf-100k*) only
#                        if named or with --all
#   --all adds heavy fixture to selection
#   --out DIR output folder (default: <root>/target/fixtures, or $GITMINI_FIXTURES_DIR)
#   --check regenerates the selection in a temporary folder and compares each ref to manifest.json;
#                        fails with "divergent fixture: refs/heads/feature expected 3f1c... got 9ab2..."
#   --update-manifest reconstructs the selection and rewrites the corresponding manifest.json entries
#   --reconstructed force even if cache is up to date
#   --tar also creates <out>/<name>.tar
#   --fsck throws git fsck also on heavy fixtures (always made for light ones)
#   --list list of fixtures (name, heavy or not, description)
#   -v, --verbose displays the output of each script (refs and stashes printed by fx_done)
#
# Output: <out>/<name>/repo/ (repository working) and, depending on the fixture, origin.git/, other/, lib.git/ (brothers of repo/:
# the remote URL is relative, the fixture is copied as is). <out>/<name>/.fixture-hash = hash of scripts:
# The fixture is only rebuilt if it changes. Generation logs are in <out>/.logs/<name>.log.
# Several build.sh can rotate in parallel (fixture lock, atomic installation).
#
# The git used is chosen by select-git.sh ($GITMINI_TEST_GIT, otherwise the git of the PATH if it is >= 2.30, otherwise /usr/bin/git).
# Compatible bash 3.2.
set -euo pipefail

# Launched from a hook git (pre-push...), these variables would refer to the repository of the hook and not the fixtures.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR \
      GIT_NAMESPACE GIT_PREFIX

FX_SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$FX_SRC/../.." && pwd)
. "$FX_SRC/select-git.sh"
gitmini_select_git || exit 1

OUT=${GITMINI_FIXTURES_DIR:-$ROOT/target/fixtures}
MODE=build; UPDATE=0; ALL=0; FORCE=0; TAR=0; FSCK=0; LIST=0; VERBOSE=0
NAMES=""   # separated by spaces (fixation names do not contain them)

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE=check ;;
    --update-manifest) UPDATE=1 ;;
    --all) ALL=1 ;;
    --force) FORCE=1 ;;
    --tar) TAR=1 ;;
    --fsck) FSCK=1 ;;
    --list) LIST=1 ;;
    -v|--verbose) VERBOSE=1 ;;
    --out) [ $# -ge 2 ] || { echo "--out attend un dossier" >&2; exit 2; }; OUT=$2; shift ;;
    --out=*) OUT=${1#--out=} ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    *) NAMES="$NAMES $1" ;;
  esac
  shift
done

# --- discovery: any script tests/fixtures/<name>.sh whose header contains « # fixture: <name> » ---
ALL_FIXTURES=""
for f in "$FX_SRC"/*.sh; do
  b=$(basename "$f" .sh)
  if [ "$(sed -n 's/^# fixture:[[:space:]]*//p' "$f" | head -n 1)" = "$b" ]; then ALL_FIXTURES="$ALL_FIXTURES $b"; fi
done
header() { sed -n "s/^# $2:[[:space:]]*//p" "$FX_SRC/$1.sh" | head -n 1; }
is_heavy() { [ "$(header "$1" heavy)" = "yes" ]; }

if [ "$LIST" -eq 1 ]; then
  for n in $ALL_FIXTURES; do
    if is_heavy "$n"; then h="lourde"; else h="      "; fi
    printf '%-18s %s  %s\n' "$n" "$h" "$(header "$n" description)"
  done
  exit 0
fi

SELECTED=""
if [ -n "$NAMES" ]; then
  for n in $NAMES; do
    case " $ALL_FIXTURES " in
      *" $n "*) SELECTED="$SELECTED $n" ;;
      *) echo "unknown fixture: $n (available:$ALL_FIXTURES)" >&2; exit 2 ;;
    esac
  done
else
  for n in $ALL_FIXTURES; do
    if [ "$ALL" -eq 1 ] || ! is_heavy "$n"; then SELECTED="$SELECTED $n"; fi
  done
fi
if [ "$ALL" -eq 1 ] && [ -n "$NAMES" ]; then
  for n in $ALL_FIXTURES; do case " $SELECTED " in *" $n "*) ;; *) SELECTED="$SELECTED $n" ;; esac; done
fi

# --- utilitaires ---
CUR_LOCK=""; CUR_TMP=""
cleanup() {
  if [ -n "$CUR_TMP" ]; then rm -rf "$CUR_TMP"; fi
  if [ -n "$CUR_LOCK" ]; then rm -rf "$CUR_LOCK"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

fixture_hash() {  # hash of the fixture script and everything it depends on
  {
    cat "$FX_SRC/$1.sh" "$FX_SRC/lib.sh" "$FX_SRC/select-git.sh" "$FX_SRC/shapes.sh" "$FX_SRC/build.sh"
    case "$1" in perf-*) cat "$FX_SRC/gen-perf-100k.py" ;; esac
  } | git hash-object --stdin
}

nap() { sleep 0.2 2>/dev/null || sleep 1; }

lock_acquire() {  # lock_acquire <nom> : verrou par fixture (mkdir est atomique)
  local lock="$OUT/.lock-$1" n=0 pid
  until mkdir "$lock" 2>/dev/null; do
    pid=$(cat "$lock/pid" 2>/dev/null || true)
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then rm -rf "$lock"; continue; fi   # owner dead
    n=$((n + 1))
    if [ "$n" -gt 3000 ]; then echo "$lock lock taken for more than 10 minutes" >&2; exit 1; fi
    nap
  done
  echo $$ > "$lock/pid"
  CUR_LOCK=$lock
}
lock_release() { rm -rf "$CUR_LOCK"; CUR_LOCK=""; }

each_repo() {  # each_repo <fix folder>: list the sous-dossiers that are repositories git
  local d
  for d in "$1"/*/; do
    d=${d%/}
    if [ -e "$d/.git" ] || { [ -f "$d/HEAD" ] && [ -d "$d/objects" ]; }; then printf '%s\n' "$d"; fi
  done
}

# build_one <name> <exit folder>: built <exit>/<name>/ (replaces existing, atomic installation)
build_one() {
  local name=$1 out=$2 tmp home log t0 rc=0 leaked d
  mkdir -p "$out/.logs"
  log="$out/.logs/$name.log"
  tmp="$out/.build-$name.$$"; CUR_TMP=$tmp
  rm -rf "$tmp"; mkdir -p "$tmp"
  home=$(mktemp -d "${TMPDIR:-/tmp}/gitmini-fx-home.XXXXXX")
  t0=$SECONDS
  FX_DIR="$tmp/repo" FX_HOME="$home" bash "$FX_SRC/$name.sh" > "$log" 2>&1 || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "fixture $name: ÉCHEC (code $rc), journal : $log" >&2
    tail -n 20 "$log" >&2
    rm -rf "$home" "$tmp"; CUR_TMP=""
    return 1
  fi
  # No path of the build (or disposable HOME) must survive in a config: the fixture is moved and copied.
  leaked=$(grep -rIl --include=config --include=.gitmodules -F -e "$tmp" -e "$home" "$tmp" 2>/dev/null || true)
  rm -rf "$home"
  if [ -n "$leaked" ]; then
    echo "fixture $name: absolute build path in: $leaked" >&2
    rm -rf "$tmp"; CUR_TMP=""
    return 1
  fi
  if [ "$FSCK" -eq 1 ] || ! is_heavy "$name"; then
    while IFS= read -r d; do
      if [ -z "$d" ]; then continue; fi
      if ! git -C "$d" fsck --no-dangling --connectivity-only >> "$log" 2>&1; then
        echo "fixture $name: git fsck fails in $d (journal: $log)" >&2
        rm -rf "$tmp"; CUR_TMP=""
        return 1
      fi
    done <<EOF
$(each_repo "$tmp")
EOF
  fi
  fixture_hash "$name" > "$tmp/.fixture-hash"
  if [ -e "$out/$name" ]; then mv "$out/$name" "$out/.old-$name.$$"; fi
  mv "$tmp" "$out/$name"; CUR_TMP=""
  rm -rf "$out/.old-$name.$$"
  if [ "$VERBOSE" -eq 1 ]; then cat "$log"; fi
  echo "fixture $name: built in $((SECONDS - t0)) s"
}

manifest() {  # <folder> <folder> <folder> <folder> <folder>
  "$PY" "$FX_SRC/manifest.py" "$1" --git "$GITMINI_TEST_GIT" --manifest "$FX_SRC/manifest.json" --name "$2" "$3"
}

if [ "$MODE" = check ] || [ "$UPDATE" -eq 1 ]; then PY=$(gitmini_python); fi

# --- --check : regeneration in a temporary folder, comparison to manifest ---
if [ "$MODE" = check ]; then
  tmpout=$(mktemp -d "${TMPDIR:-/tmp}/gitmini-fx-check.XXXXXX")
  failed=0
  for name in $SELECTED; do
    if build_one "$name" "$tmpout"; then
      if ! manifest check "$name" "$tmpout/$name"; then failed=1; fi
    else
      failed=1
    fi
  done
  if [ "$failed" -eq 0 ]; then
    rm -rf "$tmpout"
    echo "manifest.json compliant fixtures:$SELECTED"
    exit 0
  fi
  echo "regenerated fixings stored for analysis: $tmpout" >&2
  exit 1
fi

# --- construction with cache ---
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
failed_names=""
for name in $SELECTED; do
  want=$(fixture_hash "$name")
  stamp="$OUT/$name/.fixture-hash"
  if [ "$FORCE" -eq 0 ] && [ "$UPDATE" -eq 0 ] && [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$want" ]; then
    echo "fixture $name: cached"
    touch "$stamp" 2>/dev/null || true   # test harnesses compare the date of this file to that of scripts
  else
    lock_acquire "$name"
    # another process could have built it while waiting for the lock
    if [ "$FORCE" -eq 0 ] && [ "$UPDATE" -eq 0 ] && [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$want" ]; then
      echo "fixture $name: cached"
    else
      if ! build_one "$name" "$OUT"; then failed_names="$failed_names $name"; lock_release; continue; fi
    fi
    lock_release
  fi
  if [ "$UPDATE" -eq 1 ]; then manifest update "$name" "$OUT/$name"; fi
  if [ "$TAR" -eq 1 ]; then tar -cf "$OUT/$name.tar" -C "$OUT" "$name"; fi
done
if [ -n "$failed_names" ]; then echo "failed fixtures:$failed_names" >&2; exit 1; fi
