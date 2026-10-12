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
  echo "group $group absent: run first 'sudo bash scripts/firewall-linux.sh on'" >&2
  exit 1
}

# Hosted runners allow sudo as root, but their runas policy does not allow arbitrary groups.
# Enter as root, then drop back to the invoking user with the filtered primary group.
# `sudo` resets PATH; restore it and HOME after dropping privileges.
exec sudo -E -- setpriv --reuid "$(id -u)" --regid "$group" --init-groups \
  env "PATH=$PATH" "HOME=$HOME" "$@"
