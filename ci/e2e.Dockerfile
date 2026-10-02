# syntax=docker/dockerfile:1
#
# Linux e2e image (and §10.2): Ubuntu 24.04 + WebKitGTK 4.1 + WebKitWebDriver + Xvfb,
# git stable, Rust stable, Node LTS + pnpm, cargo-tauri v2, tauri-driver, just, cargo-nextest.
#
#   docker build -f ci/e2e.Dockerfile -t gitmini-e2e .
#   docker run --rm -e CARGO_TARGET_DIR=/src/target-docker -v "$PWD:/src" \
#       -v gitmini-node-modules:/src/node_modules -v gitmini-e2e-node-modules:/src/tests/e2e/node_modules \
#       -v gitmini-target-docker:/src/target-docker -v gitmini-cargo-registry:/usr/local/cargo/registry gitmini-e2e just e2e
#
# (`just e2e-docker` recipe from the justfile builds and launches this image; see ci-dessous traps.)
#
# Nothing is copied in the image: the repository is mounted in /src at execution. The build context is therefore reduced to
# entry script (see here/e2e.Dockerfile.dockerignore).
#
# PARTS
#  (a) node_modules: a `pnpm install` launched into the written Linux binary container in the repository mounted and
#      would crush those of the macOS host (esbuild, rollup, etc.). Mount volumes Docker par-dessus
#      /src/node_modules and /src/tests/e2e/node_modules (command ci-dessus); enterpoint refuses to continue if
#      These folders are not mounting points (GITMINI_ALLOW_HOST_NODE_MODULES=1 to override).
#  (b) target/: always CARGO_TARGET_DIR=/src/target-docker, not to mix with the host target/.
#  (c) user: the command runs in `ubuntu` (wid 1000), not in root (the input is root only for `chown` volumes).
#      Under Docker Desktop (macOS)
#      scripts in the bind mount belong to the host user; under Linux, add `--user "$(id -u):$(id -g)"`
#      if the uid of the host is not 1000. git refuses a repository belonging to another uid: `safe.directory=*` is
#      configured globally in the image (risk-free: disposable container).
#  (d) WebKitGTK in a container: the bubblewrap sandbox requires user namespaces, and DMA-BUF rendering does not exist
#      not under Xvfb. The variables WEBKIT_DISABLE_* ci-dessous disable them (the container is the sandbox).
#  (e) Apple Silicon: the image is built in linux/arm64 by default (WebKitGTK, rustc and node exist for
#      arm64); `--platform linux/amd64` reproduces the IC but passes through emulation (very slow).
FROM ubuntu:24.04

ARG NODE_MAJOR=24
ARG PNPM_VERSION=10.6.1

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    COREPACK_HOME=/usr/local/share/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PATH=/usr/local/cargo/bin:$PATH \
    WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 \
    WEBKIT_DISABLE_DMABUF_RENDERER=1

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# System Dependencies: Tauri 2 (WebKitGTK 4.1, appindicator, rsvg, xdo, openssl), WebKitWebDriver, Xvfb (+ xauth, required
# by xvfb-run), ffmpeg (video x11grab of chess), zstd (archives .tar.zst of tmpdir), iptables
# (pare-feu of e2e, ), python3 (gen-perf-100k.py), sudo (scripts/ci-run-offline.sh).
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl wget gnupg software-properties-common xz-utils unzip file sudo \
        build-essential pkg-config libssl-dev libcurl4-openssl-dev \
        libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev \
        webkit2gtk-driver xvfb xauth ffmpeg zstd iptables python3 \
    && rm -rf /var/lib/apt/lists/*

# stable git (PPA git-core): the version of the Ubuntu archive can delay; the nightly test also 2.30 and `next`.
# hadolint ignore=DL3008
RUN add-apt-repository -y ppa:git-core/ppa \
    && apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system --add safe.directory '*'

# Node LTS: official tarball of nodejs.org, verified by SHASUMS256.txt (amd64 → x64, arm64 → arm64).
RUN arch="$(dpkg --print-architecture)"; \
    case "$arch" in amd64) node_arch=x64 ;; arm64) node_arch=arm64 ;; *) echo "unmanaged architecture: $arch" >&2; exit 1 ;; esac; \
    base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"; \
    curl -fsSL "$base/SHASUMS256.txt" -o /tmp/SHASUMS256.txt; \
    file_name="$(grep -E " node-v[0-9.]+-linux-${node_arch}\.tar\.xz\$" /tmp/SHASUMS256.txt | awk '{ print $2 }')"; \
    curl -fsSL "$base/$file_name" -o "/tmp/$file_name"; \
    expected="$(grep " $file_name\$" /tmp/SHASUMS256.txt | awk '{ print $1 }')"; \
    actual="$(sha256sum "/tmp/$file_name" | awk '{ print $1 }')"; \
    [ -n "$expected" ] && [ "$expected" = "$actual" ] || { echo "SHA-256 invalid for $file_name" >&2; exit 1; }; \
    tar -xJf "/tmp/$file_name" -C /usr/local --strip-components=1 --no-same-owner; \
    rm -f /tmp/SHASUMS256.txt "/tmp/$file_name"; \
    node --version

# pnpm via corepack (delivered with node 24 LTS), version aligned with `packageManager` of the root package.json.
RUN corepack enable \
    && corepack prepare "pnpm@${PNPM_VERSION}" --activate

# Rust stable via rustup (rust-toolchain.toml of repository stable demand + clippy + rustfmt).
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable \
        --component clippy --component rustfmt --no-modify-path \
    && rustc --version

# Cargo tools, one layer each (the Docker build cache keeps them independently).
# hadolint ignore=DL3059
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    cargo install --locked just
# hadolint ignore=DL3059
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    cargo install --locked cargo-nextest
# hadolint ignore=DL3059
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    cargo install --locked tauri-cli --version '^2'
# hadolint ignore=DL3059
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    cargo install --locked tauri-driver

# User non-root `ubuntu` (wid 1000, provided by image 24.04); /src is the repository mounting point.
# /tmp/.X11-unix exists in advance (1777) so that Xvfb does not require root.
RUN mkdir -p /src /usr/local/cargo/registry /tmp/.X11-unix \
    && chmod 1777 /tmp/.X11-unix \
    && chown -R ubuntu:ubuntu /src /usr/local/cargo /usr/local/rustup /usr/local/share/corepack /home/ubuntu

COPY --chmod=0755 ci/e2e-entrypoint.sh /usr/local/bin/gitmini-e2e-entrypoint

# No `USER`: the input starts in root, gives the volumes to `ubuntu` and then runs in `ubuntu` (see the header of
# ci/e2e-entrypoint.sh).
WORKDIR /src
# The input launches all commands on Xvfb (xvfb-run -a -s "-screen 0 1280x800x24"), without command: a shell.
ENTRYPOINT ["/usr/local/bin/gitmini-e2e-entrypoint"]
CMD ["bash"]
