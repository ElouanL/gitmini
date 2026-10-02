# End-to-end harness

WebdriverIO drives either a native Tauri WebView or Chrome connected to `gitmini-bridge`. Each test copies a deterministic fixture into a separate temporary directory and checks UI behavior and Git state.

```sh
pnpm --dir tests/e2e install --frozen-lockfile
pnpm --dir tests/e2e run test
pnpm --dir tests/e2e run lint
pnpm --dir tests/e2e run typecheck
just e2e-web
just e2e-web --spec specs/gh-01.linear.e2e.ts
```

Native tests run with `just e2e` on Linux/Windows. macOS has no native WebView WebDriver support; use `just e2e-web` or `just e2e-docker`. Build the frontend with `VITE_GITMINI_GITHUB_LOGIN=1` when running GitHub scenarios directly; the `just` recipes and CI E2E builds do this automatically.

Spec names use `<scenario-id>.<fixture>.e2e.ts`; optional matching `.setup.ts` files arrange scenario state. Helpers manage fixtures, ports, tokens, application sessions and teardown. The GitHub mock runs locally, and the native CI tests retain their network restrictions.

Artifacts live in `.artifacts` and include `run.json`, logs, screenshots and failure recordings. `GITMINI_E2E_ARTIFACTS` selects another directory. `GITMINI_TEST_SEED` reproduces scheduling, `GITMINI_E2E_WORKERS` controls concurrency, and `GITMINI_E2E_KEEP_TMP=1` preserves temporary files for investigation. Run `node scripts/check-ghosts.mjs` after manually invoking WDIO to detect surviving processes.

Harness self-tests use `wdio.selftest.conf.ts` and `wdio.selftest-tauri.conf.ts`; performance tests use `wdio.perf.conf.ts`. See [testing](../../docs/testing.md) for the full validation workflow.
