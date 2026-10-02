#!/usr/bin/env bash
# Launches a command in the group filtered by scripts/firewall-linux.sh (loopback only).
#   scripts/ci-run-offline.sh <command> [args...]
# The environment (PATH, HOME, GITMINI_*, DISPLAY...) is preserved; only the primary group changes.
set -euo pipefail

group=${GITMINI_OFFLINE_GROUP:-gitmininonet}
[ "$#" -ge 1 ] || {
  echo "usage: $0 <command> [args...]" >&2
  exit 2
}
getent group "$group" >/dev/null || {
  echo "group $group absent: run first 'sudo scripts/firewall-linux.sh we're on." >&2
  exit 1
}

# `sudo` gives PATH back to secure_path: it is explicitly re-imposed with HOME, in addition to -E.
exec sudo -E -u "$(id -un)" -g "$group" -- env "PATH=$PATH" "HOME=$HOME" "$@"
