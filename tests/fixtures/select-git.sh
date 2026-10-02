# select-git.sh -- choice of a git binary >= 2.30 for fixtures (sourced by lib.sh and build.sh).
#
# Order: $GITMINI_TEST_GIT (explicit, never ignored), then `git` of PATH if it is >= 2.30, then
# /usr/bin/git if >= 2.30. The folder of the selected binary is prefixed to PATH: a `git` too old
# The front position in the PATH is thus hidden, including for `git` launched by git itself or by a hook.
# Exports GITMINI_TEST_GIT (absolute path of the selected binary). Compatible bash 3.2.

gitmini_git_ok() {   # gitmini_git_ok <binaire>: success if version is >= 2.30
  local v major minor
  v=$("$1" --version 2>/dev/null) || return 1
  v=${v#git version }
  major=${v%%.*}; v=${v#*.}; minor=${v%%.*}
  case "$major$minor" in *[!0-9]*|'') return 1 ;; esac
  [ "$major" -gt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -ge 30 ]; }
}

gitmini_select_git() {
  local cand resolved=""
  if [ -n "${GITMINI_TEST_GIT:-}" ]; then
    if ! gitmini_git_ok "$GITMINI_TEST_GIT"; then
      echo "GITMINI_TEST_GIT=$GITMINI_TEST_GIT n'est pas un git >= 2.30" >&2
      return 1
    fi
    resolved=$GITMINI_TEST_GIT
  else
    for cand in "$(command -v git 2>/dev/null || true)" /usr/bin/git; do
      if [ -n "$cand" ] && [ -x "$cand" ] && gitmini_git_ok "$cand"; then resolved=$cand; break; fi
    done
  fi
  if [ -z "$resolved" ]; then
    echo "Git >= 2.30 not found (Git in PATH is too old or missing; set GITMINI_TEST_GIT)" >&2
    return 1
  fi
  case "$resolved" in /*) ;; *) resolved=$(command -v "$resolved") ;; esac
  GITMINI_TEST_GIT=$resolved; export GITMINI_TEST_GIT
  PATH="$(dirname "$resolved"):$PATH"; export PATH
}

# gitmini_python: Writes the name of a Python 3 interpreter (python3, otherwise python).
gitmini_python() {
  local p
  for p in python3 python; do
    if command -v "$p" >/dev/null 2>&1 && "$p" -c 'import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)' 2>/dev/null; then
      printf '%s\n' "$p"; return 0
    fi
  done
  echo "python 3 introuvable" >&2
  return 1
}
