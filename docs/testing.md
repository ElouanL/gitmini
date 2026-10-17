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
just e2e-pw                          # Playwright, same Chrome + bridge stack (tests/playwright)
just e2e-pw specs/ui-12.with-remote.spec.ts
just e2e                            # Native Tauri WebView on Linux/Windows
just e2e-docker                     # Linux native tests from macOS
```

Install the harness dependencies with `pnpm --dir tests/e2e install --frozen-lockfile`. E2E builds explicitly enable the GitHub flag; production builds keep it off. Native macOS WebDriver testing is unavailable; use browser coverage plus the release smoke tests described in [releases](releases.md).

The harness stores failure logs, screenshots and recordings under `tests/e2e/.artifacts`. Each run has its own temporary repositories and process marker. `scripts/check-ghosts.mjs` detects leftover processes. The test-policy check rejects focused tests and unapproved skips; documented performance/self-test conditions are explicit exceptions.

### Playwright harness

`tests/playwright` is a second browser harness, additional to WebdriverIO and built on the same pieces: the `gitmini-bridge` development bridge serving `dist/`, the deterministic fixtures copied into isolated temporary folders, the GitHub mock, the `gitmini-e2e-<runId>` process marker and `scripts/check-ghosts.mjs`. It is web-mode only (no CSP or Tauri capability coverage), so native coverage remains with WebdriverIO. Each Playwright test owns a fixture copy, HOME, bridge process on a free port and browser context, so specs run in parallel (`GITMINI_E2E_WORKERS`). Nothing is built implicitly: `just e2e-pw` builds the frontend (`VITE_GITMINI_GITHUB_LOGIN=1 pnpm build`) and the bridge, runs `playwright test` and then checks for ghost processes.

```sh
pnpm --dir tests/playwright install --frozen-lockfile
pnpm --dir tests/playwright run test         # unit tests of the harness helpers
pnpm --dir tests/playwright run lint
pnpm --dir tests/playwright run typecheck
just e2e-pw specs/ui-12.with-remote.spec.ts
```

It uses a Chrome that is already on the machine (`GITMINI_CHROME_BIN`, a system Google Chrome, or the Chrome for Testing that WebdriverIO downloaded); otherwise run `pnpm --dir tests/playwright exec playwright install chromium` once. Failure artifacts (Playwright trace and screenshot, git state, bridge logs, temporary repository archive) go to `tests/playwright/.artifacts/run-<id>/`. Specs use the same rules as the WebdriverIO ones (no fixed waits, no retries, no focused or skipped tests; `just check-test-policy` and the `tests` ESLint config cover both). See the [harness README](../tests/playwright/README.md) for the fixtures and helpers API and a WebdriverIO porting table. `specs/mock-smoke.spec.ts` is the exception to the bridge stack: it runs the `?mock=1` demo mode (the in-memory transport of `pnpm dev`) on a Vite dev server it starts itself and fails on any console error or warning, so the mock stays usable for every feature.

## Full checks and CI

`just lint` checks formatting, generated types, IPC permissions, Git write boundaries, Clippy, frontend and harness types/lint, bundle size, test policy and Rust dependency licenses. CI also runs frontend tests, script tests and npm production-license checks, and installs the Playwright harness for its lint, type and unit checks (the Playwright end-to-end suite is local for now). Native Linux E2E tests and performance checks remain in the existing workflow; Windows and nightly coverage retain their existing schedules.
