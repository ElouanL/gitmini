# Testing

## Fast checks

```sh
pnpm check
pnpm lint
pnpm test
just test
```

`just test` generates deterministic fixture repositories, runs `cargo nextest run --workspace` and then doctests. Install cargo-nextest before using it. The frontend uses Vitest and jsdom with a fake IPC transport. Rust tests cover the real Git core and the desktop integration. The E2E harness has its own unit tests:

```sh
pnpm --dir tests/e2e run test
node --test 'scripts/*.test.mjs' 'tests/support/**/*.test.mjs' 'tests/perf/*.test.mjs'
```

## Fixtures

```sh
just fixtures --check
node tests/fixtures/build.mjs --update-manifest
bash tests/fixtures/verify.sh
```

Fixtures are generated under `target/fixtures` and copied into isolated temporary directories by tests. Git configuration, timestamps and identity are deterministic. The tracked manifest checks refs, HEAD and stash contents. See [fixture documentation](../tests/fixtures/README.md).

Unicode filenames and non-English sample data are retained where they test encoding or locale handling; application messages and test descriptions are English.

## End-to-end tests

```sh
just e2e-web                         # Browser + real Rust development bridge
just e2e-web --spec specs/gh-01.linear.e2e.ts
just e2e                            # Native Tauri WebView on Linux/Windows
just e2e-docker                     # Linux native tests from macOS
```

Install the harness dependencies with `pnpm --dir tests/e2e install --frozen-lockfile`. E2E builds explicitly enable the GitHub flag; production builds keep it off. Native macOS WebDriver testing is unavailable; use browser coverage plus the release smoke tests described in [releases](releases.md).

The harness stores failure logs, screenshots and recordings under `tests/e2e/.artifacts`. Each run has its own temporary repositories and process marker. `scripts/check-ghosts.mjs` detects leftover processes. The test-policy check rejects focused tests and unapproved skips; documented performance/self-test conditions are explicit exceptions.

## Full checks and CI

`just lint` checks formatting, generated types, IPC permissions, Git write boundaries, Clippy, frontend and harness types/lint, bundle size, test policy and Rust dependency licenses. CI also runs frontend tests, script tests and npm production-license checks. Native Linux E2E tests and performance checks remain in the existing workflow; Windows and nightly coverage retain their existing schedules.
