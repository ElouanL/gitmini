#!/usr/bin/env bash
# Development bridge: the interface in an ordinary browser (Chrome), against the true backend git (gitmini-core).
#
#   scripts/dev-web.sh [<repository path>] [--port 1430] [--static-dir dist] [--config-dir <folder>]
#
# Build the frontend (`pnpm build`) if missing (`dist/index.html`), then launch `gitmini-bridge`, which serves
# `dist/` and API `/__gitmini/*` on http://127.0.0.1:1430. All arguments are transmitted to the bridge.
# Voir crates/gitmini-bridge/README.md.
#
# Variables: GITMINI_DEV_WEB_REBUILD=1 force `pnpm build`; GITMINI_TEST_MODE (default 1 here: keyring in memory,
# no invite of the macOS box) ; RUST_LOG ; GITMINI_* of the e2e build .
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
export PATH="$HOME/.cargo/bin:/usr/bin:$PATH"
export GITMINI_TEST_MODE="${GITMINI_TEST_MODE:-1}"

case "${1:-}" in
  -h | --help)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
esac

# Custom `--static-dir`: nothing is built (the file is the one of the caller).
custom_static=0
for arg in "$@"; do
  case "$arg" in --static-dir | --static-dir=*) custom_static=1 ;; esac
done

if [[ "$custom_static" == 0 && ( "${GITMINI_DEV_WEB_REBUILD:-0}" == 1 || ! -f dist/index.html ) ]]; then
  echo "dev-web: dist/ absent or reconstruction requested: pnpm built" >&2
  if [[ ! -d node_modules ]]; then
    pnpm install --frozen-lockfile
  fi
  pnpm build
fi

exec cargo run -q -p gitmini-bridge -- "$@"
