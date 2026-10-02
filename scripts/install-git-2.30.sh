#!/usr/bin/env bash
# Install git 2.30.9 (minimum supported version, specs/) in a prefix.
#
#   scripts/install-git-2.30.sh [<prefix>] defect: $HOME/.gitmini-tools/git-2.30.9
#
# Envelope of scripts/install-git-from-source.sh (tarball kernel.org verified by SHA -256, building without Perl/Python/
# gettext/OpenSSL/expat, with libcurl for git-http-backend and git-remote-https) which makes the compilation hermetic
# on macOS: without this, the Git Makefile 2.30 adds /opt/local (MacPorts: libraries x86_64, "ignoring file ...
# found architecture 'x86_64' and then "symbol(s) not found for architecture arm64" and the `curl-config` of the first
# conda/MacPorts of the PATH. This is done with NO_DARWIN_PORTS=1 and a PATH reduced to the system tools.
#
# Samepotent: if <prefix> already contains the same build, nothing is recompiled (cache possible on <prefix>).
# The binary is linked to its <prefix>: do not move the folder. Installed size: ~25 MB.
#
# Use with tests (recipe `just test-git-2.30`, tests/git-compat/README.md):
#   export GITMINI_TEST_GIT=<prefix>/bin/git PATH="<prefix>/bin:$PATH"
set -euo pipefail

prefix=${1:-$HOME/.gitmini-tools/git-2.30.9}
here=$(cd "$(dirname "$0")" && pwd)

if [ "$(uname -s)" = Darwin ]; then
  export NO_DARWIN_PORTS=1
  unset CFLAGS CPPFLAGS LDFLAGS CPATH LIBRARY_PATH C_INCLUDE_PATH CONDA_PREFIX
  PATH=/usr/bin:/bin:/usr/sbin:/sbin
  export PATH
fi

bash "$here/install-git-from-source.sh" 2.30.9 "$prefix"

# Controls specific to the 2.30 compatibility (the GitHub mock of the tests is based on http-backend and remote-http).
version=$("$prefix/bin/git" --version)
[ "$version" = "git version 2.30.9" ] || {
  echo "version inattendue : $version" >&2
  exit 1
}
for f in git-http-backend git-remote-http git-remote-https; do
  [ -e "$prefix/libexec/git-core/$f" ] || {
    echo "absent : $prefix/libexec/git-core/$f" >&2
    exit 1
  }
done
echo "$version : $prefix/bin/git"
