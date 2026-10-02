# gitmini — development commands
# Prefer a recent system Git over an older Homebrew installation.
set shell := ["bash", "-cu"]
export PATH := env("HOME") + "/.cargo/bin:/usr/bin:/opt/homebrew/bin:" + env("PATH")

default:
    @just --list

# Development: Tauri app and Vite
dev:
    cargo tauri dev

build:
    pnpm install --frozen-lockfile
    cargo tauri build

# Generates fixtures (idempotent, hash cache scripts); --check verifies manifest
fixtures *ARGS:
    node tests/fixtures/build.mjs {{ARGS}}

# Quick tests: unit + Rust integration
test: fixtures
    cargo nextest run --workspace
    cargo test --workspace --doc

# Types TypeScript generated from Rust types (src/lib/ipc/types.ts)
gen-types:
    cargo run -q -p gitmini-core --example gen_types

# E2E on the real binary (Linux / Windows; refuses macOS)
e2e: fixtures
    {{ if os() == "macos" { error("Native e2e is unavailable on macOS (no WKWebView driver). Use 'just e2e-docker'.") } else { "" } }}
    VITE_GITMINI_GITHUB_LOGIN=1 cargo tauri build --debug --features e2e --no-bundle
    pnpm --dir tests/e2e exec wdio run wdio.conf.ts
    node scripts/check-ghosts.mjs

# E2E Linux in a container (for macOS), with a separate target/
e2e-docker:
    docker build -f ci/e2e.Dockerfile -t gitmini-e2e . && docker run --rm -e CARGO_TARGET_DIR=/src/target-docker -v "$PWD:/src" -v gitmini-target-docker:/src/target-docker -v gitmini-node-modules:/src/node_modules -v gitmini-e2e-node-modules:/src/tests/e2e/node_modules gitmini-e2e just e2e

# E2E in local web mode (macOS / Linux): Chrome + `gitmini-bridge` development bridge (real backend, WebView = Chrome)
e2e-web *ARGS: fixtures
    VITE_GITMINI_GITHUB_LOGIN=1 pnpm build
    cargo build -p gitmini-bridge
    GITMINI_E2E_WORKERS=${GITMINI_E2E_WORKERS:-4} pnpm --dir tests/e2e exec wdio run wdio.web.conf.ts {{ARGS}}
    node scripts/check-ghosts.mjs

# Perf measurements: (informative), boot and memory without WebDriver, then WDIO off macOS
perf: fixtures
    cargo bench -p gitmini-core
    VITE_GITMINI_GITHUB_LOGIN=1 cargo tauri build --features e2e --no-bundle -- --profile release-perf
    node tests/perf/startup.mjs
    {{ if os() == "macos" { "" } else { "pnpm --dir tests/e2e exec wdio run wdio.perf.conf.ts" } }}

check-test-policy:
    node scripts/check-test-policy.mjs

lint:
    cargo fmt --all --check
    cargo run -q -p gitmini-core --example gen_types -- target/types.check.ts && diff -u src/lib/ipc/types.ts target/types.check.ts
    node scripts/check-commands.mjs
    node scripts/check-no-gix-writes.mjs
    cargo clippy --workspace --all-targets -- -D warnings
    pnpm exec svelte-check
    pnpm exec eslint .
    pnpm size
    pnpm --dir tests/e2e run lint
    pnpm --dir tests/e2e run typecheck
    just check-test-policy
    cargo deny check
