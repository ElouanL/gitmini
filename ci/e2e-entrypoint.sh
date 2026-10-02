#!/usr/bin/env bash
# Image entry point gitmini-e2e (c/e2e.Dockerfile): installs the Linux dependencies of the repository mounted in /src and then
# executes the command requested on Xvfb (screen 1280x800x24, like the e2e-linux job of the IC).
#
# Start root for one reason: Docker volumes (node_modules, target-docker, cargo registry) are created
# `root:root` and the user `ubuntu` (wid 1000) could not write there. So it gives them ubuntu for owner, then
# re-executes in `ubuntu` (`setpriv`): the requested command never runs in root. Under `--user 1000:1000`, this step is
# Jumped.
#
# Xvfb: `xvfb-run` must not be the not PID 1 of the container (it expectations a SIGUSR1 of Xvfb that the PID 1 does not receive: the
# The container remains frozen without displaying anything. So we run it in wire process and relay SIGTERM / SIGINT.
#
# Variables: GITMINI_E2E_SKIP_INSTALL=1 skips `pnpm install`; GITMINI_ALLOW_HOST_NODE_MODULES=1 allows for
# node_modules which are not Docker volumes (crushes those of the host: see the trap (a) of the Dockerfile).
set -euo pipefail

if [ "$(id -u)" = 0 ]; then
  for dir in /src/node_modules /src/tests/e2e/node_modules /src/target-docker /usr/local/cargo/registry /usr/local/cargo/git; do
    if mountpoint -q "$dir" 2>/dev/null; then chown ubuntu:ubuntu "$dir"; fi
  done
  exec setpriv --reuid=1000 --regid=1000 --init-groups env HOME=/home/ubuntu USER=ubuntu LOGNAME=ubuntu "$0" "$@"
fi

cd /src

if [ "${GITMINI_E2E_SKIP_INSTALL:-0}" != 1 ] && [ -f package.json ]; then
  if [ "${GITMINI_ALLOW_HOST_NODE_MODULES:-0}" != 1 ]; then
    for dir in /src/node_modules /src/tests/e2e/node_modules; do
      if ! mountpoint -q "$dir" 2>/dev/null; then
        cat >&2 <<EOF
$dir is not a Docker volume: pnpm would write Linux binaries there and break the host node_modules.
Add these mounts to docker run: -v gitmini-node-modules:/src/node_modules -v gitmini-e2e-node-modules:/src/tests/e2e/node_modules
(or set GITMINI_ALLOW_HOST_NODE_MODULES=1 to override, or GITMINI_E2E_SKIP_INSTALL=1 if dependencies are already installed).
EOF
        exit 1
      fi
    done
  fi
  pnpm install --frozen-lockfile
  if [ -f tests/e2e/package.json ]; then
    pnpm --dir tests/e2e install --frozen-lockfile
  fi
fi

if [ "$#" -eq 0 ]; then
  set -- bash
fi
xvfb-run -a -s "-screen 0 1280x800x24" "$@" &
child=$!
trap 'kill -TERM "$child" 2>/dev/null || true' TERM INT
status=0
wait "$child" || status=$?
# a relayed signal interrupts the first `wait`: we wait for the actual end of the wire
if kill -0 "$child" 2>/dev/null; then wait "$child" || status=$?; fi
exit "$status"
