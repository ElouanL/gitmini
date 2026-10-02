#!/usr/bin/env bash
# Apt packages of Linux jobs (ubuntu-24.04; ubuntu-22.04 for release).
#   scripts/ci-install-linux-deps.sh <profil>…
# Profils :
#   build        compile the workspace (Tauri 2 : WebKitGTK 4.1, appindicator, rsvg, xdo, openssl)
#   git-build compile git from sources (scripts/install-git-from-source.sh)
#   e2e-runtime run the e2e binary : WebKitGTK, webkit2gtk-driver, Xvfb, ffmpeg (failure video), zstd
#   git-stable git stable from PPA git-core
#   release build + patchelf/xdg-utils for .deb and .AppImage bundles
set -euo pipefail

[ "$#" -ge 1 ] || {
  echo "usage: $0 <build|git-build|e2e-runtime|git-stable|release>…" >&2
  exit 2
}

packages=()
stable_git=0
for profile in "$@"; do
  case "$profile" in
    build)
      packages+=(build-essential pkg-config libssl-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev)
      ;;
    git-build) packages+=(build-essential libcurl4-openssl-dev zlib1g-dev) ;;
    e2e-runtime)
      packages+=(libwebkit2gtk-4.1-0 libayatana-appindicator3-1 librsvg2-2 libxdo3 webkit2gtk-driver xvfb xauth ffmpeg zstd)
      ;;
    git-stable) stable_git=1 ;;
    release)
      packages+=(build-essential pkg-config libssl-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev patchelf xdg-utils file)
      ;;
    *)
      echo "profil inconnu : $profile" >&2
      exit 2
      ;;
  esac
done

sudo apt-get update -qq
if [ "$stable_git" = 1 ]; then
  sudo apt-get install -y -qq --no-install-recommends software-properties-common
  sudo add-apt-repository -y ppa:git-core/ppa
  sudo apt-get update -qq
  packages+=(git)
fi
if [ "${#packages[@]}" -gt 0 ]; then
  # `sort -u`: profiles overlap.
  mapfile -t unique < <(printf '%s\n' "${packages[@]}" | sort -u)
  sudo apt-get install -y -qq --no-install-recommends "${unique[@]}"
fi
