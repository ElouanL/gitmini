#!/usr/bin/env bash
# Firewall exiting Linux e2e (: "no network access in no test").
#
#   sudo scripts/firewall-linux.sh we rule "scoped" : only the processes of the gitmininonet group lose the network
#   sudo scripts/firewall-linux.sh strict literal rule of spec: `-P OUTPUT DROP` except loopback, for TOUT host
#   sudo scripts/firewall-linux.sh off removes rules (idempotent)
#   scripts/firewall-linux.sh verify fails if the network remains reachable for the group (requires `on`)
#
# Why? `on` is not one `-P OUTPUT DROP` Overall on Runners GitHub : the runner himself (newspapers, artifacts,
# heartbeat) exits by the same network; shutting down the host kills the job. `on` mode gets the desired guarantee (tests
# do not reach any external host, including DNS) by filtering on the group owner of the socket: we launch the
# tests with `scripts/ci-run-offline.sh <commande…>`, which passes in gitmininonet group (sudo -g). Loopback allowed (mock
# GitHub, tauri-driver, WebKitWebDriver, Xvfb), all the rest is REJECT (immediate failure, no timeout).
# `strict` is suitable for a disposable container or VM (e.g. `docker run --cap-add NET_ADMIN`), never for a hosted runner.
set -euo pipefail

group=${GITMINI_OFFLINE_GROUP:-gitmininonet}
chain=GITMINI_OFFLINE
cmd=${1:-on}

ipt() { # ipt <args...>: IPv4 and then IPv6 (IPv6 ignored if ip6tables are missing)
  iptables "$@"
  if command -v ip6tables >/dev/null 2>&1; then ip6tables "$@"; else echo "ip6tables absent: unfiltered IPv6" >&2; fi
}

need_root() {
  [ "$(id -u)" -eq 0 ] || {
    echo "root requis : sudo $0 $cmd" >&2
    exit 1
  }
}

remove_scoped() {
  for tool in iptables ip6tables; do
    command -v "$tool" >/dev/null 2>&1 || continue
    while "$tool" -C OUTPUT -m owner --gid-owner "$group" -j "$chain" 2>/dev/null; do
      "$tool" -D OUTPUT -m owner --gid-owner "$group" -j "$chain"
    done
    "$tool" -F "$chain" 2>/dev/null || true
    "$tool" -X "$chain" 2>/dev/null || true
  done
}

remove_strict() {
  for tool in iptables ip6tables; do
    command -v "$tool" >/dev/null 2>&1 || continue
    "$tool" -P OUTPUT ACCEPT
    "$tool" -F OUTPUT
  done
}

case "$cmd" in
  on)
    need_root
    getent group "$group" >/dev/null || groupadd "$group"
    remove_scoped
    ipt -N "$chain"
    ipt -A "$chain" -o lo -j ACCEPT
    ipt -A "$chain" -j REJECT
    ipt -I OUTPUT 1 -m owner --gid-owner "$group" -j "$chain"
    echo "pare-feu active for the group $group (loopback only); run tests via scripts/ci-run-offline.sh"
    ;;
  strict)
    need_root
    ipt -F OUTPUT
    ipt -A OUTPUT -o lo -j ACCEPT
    ipt -P OUTPUT DROP
    echo "Strict active pare-feu: all non loopback outgoing traffic is abandoned"
    ;;
  off)
    need_root
    remove_scoped
    remove_strict
    echo "pare-feu removed"
    ;;
  verify)
    here=$(cd "$(dirname "$0")" && pwd)
    getent group "$group" >/dev/null || {
      echo "group $group absent: run first 'sudo $0 on'" >&2
      exit 1
    }
    # 1.1.1.1 avoids DNS; github.com also checks name resolution. Neither of them must answer: we demand
    # a "inaccessible network" curl code (6 DNS, 7 connection, 28 delay), not a sudo failure (code 1).
    for target in https://1.1.1.1 https://github.com; do
      status=0
      bash "$here/ci-run-offline.sh" curl -sS --max-time 5 -o /dev/null "$target" 2>/dev/null || status=$?
      case "$status" in
        0)
          echo "FAILED: $target is still reachable under group $group" >&2
          exit 1
          ;;
        6 | 7 | 28) ;;
        *)
          echo "CHECK: Unexpected code $status for $target (sudo or curl in default?)" >&2
          exit 1
          ;;
      esac
    done
    echo "OK: no external host can be reached under the $group group"
    ;;
  *)
    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//' >&2
    exit 2
    ;;
esac
