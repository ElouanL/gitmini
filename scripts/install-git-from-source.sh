#!/usr/bin/env bash
# Compile and install git from the sources (and §10.1).
#
#   scripts/install-git-from-source.sh <version的branche> <prefix> [<sha>]
#
#   <version> release number (ex. 2.30.9): tarball kernel.org, verified by SHA-256 (see TARBALLS ci-dessous)
#   <branche> branch of https://github.com/git/git (e.g. next); <sha> optional freezes the commit (cache key)
#   <prefix> installation folder (e.g. $HOME/git-2.30.9); add <prefix>/bin to PATH then
#
# The binary is linked to its <prefix> (libexec/git-core, git-http-backend, git-remote-https are installed):
# move the folder after the blow. Samepotent: if <prefix> already contains the same build (file .gitmini-git-build), nothing
# is recompiled, allowing <prefix> to cache with actions/cache.
#
# Compilation Dependencies (Ubuntu): build-essential libcurl4-openssl-dev zlib1g-dev
# (scripts/ci-install-linux-deps.sh git-build). Variables: GITMINI_GIT_PERL=1 compiles with Perl (default: NO_PERL=1);
# GITMINI_GIT_TARBALL_SHA256 provides the hash of an unlisted version.
set -euo pipefail

# SHA-256 of .tar.xz tarballs, read in https://mirrors.edge.kernel.org/pub/software/scm/git/sha256sums.asc
# (function rather than associative array: also works with bash 3.2 of macOS).
pinned_sha256() {
  case "$1" in
    2.30.9) echo 4e3985a641d9ebdfec9e56b370cdbe362a672d9b45270c1acb1406cdab0f5bb4 ;;
  esac
}
RECIPE=1 # to increment when ci-dessous compilation options change (invalidates caches)

sha256_of() { # GNU sha256sum, otherwise shasum (macOS)
  if command -v sha256sum >/dev/null 2>&1 && sha256sum "$1" >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

usage() {
  sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

[ "$#" -ge 2 ] && [ "$#" -le 3 ] || usage
ref=$1
prefix=$2
sha=${3:-}

case "$prefix" in
  /*) ;;
  *) prefix="$PWD/$prefix" ;;
esac

stamp="$ref|$sha|perl=${GITMINI_GIT_PERL:-0}|recipe=$RECIPE"
if [ -x "$prefix/bin/git" ] && [ -f "$prefix/.gitmini-git-build" ] && [ "$(cat "$prefix/.gitmini-git-build")" = "$stamp" ]; then
  echo "Git already installed in $prefix : $("$prefix/bin/git" --version)"
  exit 0
fi

jobs=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
src="$work/src"

if [[ "$ref" =~ ^[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$ ]]; then
  tarball="git-$ref.tar.xz"
  url="https://mirrors.edge.kernel.org/pub/software/scm/git/$tarball"
  expected=${GITMINI_GIT_TARBALL_SHA256:-$(pinned_sha256 "$ref")}
  if [ -z "$expected" ]; then
    echo "::warning::hash of git-$ref unpinned in scripts/install-git-from-source.sh: reading sha256sums.asc on kernel.org (first-use confidence)" >&2
    expected=$(curl -fsSL "https://mirrors.edge.kernel.org/pub/software/scm/git/sha256sums.asc" |
      awk -v f="$tarball" '$2 == f { print $1 }')
    [ -n "$expected" ] || {
      echo "hash not found for $tarball" >&2
      exit 1
    }
  fi
  curl -fsSL --retry 3 -o "$work/$tarball" "$url"
  [ "$(sha256_of "$work/$tarball")" = "$expected" ] || {
    echo "SHA-256 invalid for $tarball" >&2
    exit 1
  }
  mkdir -p "$src"
  tar -xJf "$work/$tarball" -C "$src" --strip-components=1
else
  # Branch (e.g. next): superficial clone, possibly frozen on <sha>. The git of PATH is used to clone.
  repo="https://github.com/git/git.git"
  if [ -n "$sha" ]; then
    git init -q "$src"
    git -C "$src" remote add origin "$repo"
    git -C "$src" fetch -q --depth 1 origin "$sha"
    git -C "$src" checkout -q FETCH_HEAD
  else
    git clone -q --depth 1 --branch "$ref" "$repo" "$src"
    sha=$(git -C "$src" rev-parse HEAD)
    stamp="$ref|$sha|perl=${GITMINI_GIT_PERL:-0}|recipe=$RECIPE"
  fi
fi

make_args=(
  "prefix=$prefix"
  NO_GETTEXT=1 NO_TCLTK=1 NO_PYTHON=1 NO_EXPAT=1 NO_OPENSSL=1 NO_INSTALL_HARDLINKS=1
)
[ "${GITMINI_GIT_PERL:-0}" = 1 ] || make_args+=(NO_PERL=1)

log="$work/build.log"
{
  make -C "$src" -j"$jobs" "${make_args[@]}" all &&
    make -C "$src" "${make_args[@]}" install
} >"$log" 2>&1 || {
  tail -n 60 "$log" >&2
  echo "compilation of failed git ($ref)" >&2
  exit 1
}

# git-http-backend (mock GitHub, ) et git-remote-https (libcurl) doivent exister.
for f in "$prefix/bin/git" "$prefix/libexec/git-core/git-http-backend" "$prefix/libexec/git-core/git-remote-https"; do
  [ -e "$f" ] || {
    echo "Expected file missing: $f" >&2
    exit 1
  }
done
printf '%s\n' "$stamp" >"$prefix/.gitmini-git-build"
echo "Git installed in $prefix : $("$prefix/bin/git" --version)"
