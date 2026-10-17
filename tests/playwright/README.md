# Playwright end-to-end harness

[Playwright Test](https://playwright.dev/docs/intro) drives Chrome against `gitmini-bridge`, the development bridge that serves the built frontend and hosts the real `gitmini-core` backend ([bridge README](../../crates/gitmini-bridge/README.md)). It is additional to the WebdriverIO harness in [`tests/e2e`](../e2e/README.md): same application under test, same fixtures (`tests/fixtures`), same isolation rules. It is browser-only (no Tauri WebView, so no CSP or capability coverage); the native tests stay in WebdriverIO.

Every test gets its own repository (a copy of a named fixture), HOME, `settings.json` folder, `gitmini-bridge` process and browser context, so tests are independent and run in parallel.

## Run

```sh
just e2e-pw                                          # builds frontend + bridge, runs everything, checks for ghost processes
just e2e-pw specs/ui-12.with-remote.spec.ts          # one spec
GITMINI_E2E_WORKERS=2 just e2e-pw --grep "UI-12"

# or by hand (nothing is built implicitly; the global setup tells you what is missing)
node tests/fixtures/build.mjs
VITE_GITMINI_GITHUB_LOGIN=1 pnpm build
cargo build -p gitmini-bridge
pnpm --dir tests/playwright install --frozen-lockfile
pnpm --dir tests/playwright exec playwright test specs/ui-12.with-remote.spec.ts
node scripts/check-ghosts.mjs --artifacts tests/playwright/.artifacts

pnpm --dir tests/playwright run test         # unit tests of the harness helpers (no browser)
pnpm --dir tests/playwright run lint
pnpm --dir tests/playwright run typecheck
```

The frontend must be built with `VITE_GITMINI_GITHUB_LOGIN=1` for the GitHub scenarios (`just e2e-pw` does it). `playwright test --debug` and `PWDEBUG=1` work as usual; `pnpm --dir tests/playwright exec playwright show-trace <trace.zip>` opens a failure trace.

### Browser

No download is needed on a machine that already has a Chrome. The first match wins:

1. `GITMINI_CHROME_BIN`: path to Chrome, Chromium, Brave...
2. A system Google Chrome (Playwright channel `chrome`; preinstalled on GitHub's Ubuntu runners).
3. Chrome for Testing already downloaded by the WebdriverIO harness (`~/.cache/gitmini-e2e-drivers`, or `GITMINI_E2E_DRIVER_CACHE`).
4. Playwright's own Chromium, which needs the one-time `pnpm --dir tests/playwright exec playwright install chromium`.

The global setup prints which one it uses.

### Variables

| Variable | Effect |
| --- | --- |
| `GITMINI_E2E_WORKERS` | Parallel workers (default 1, at most 16; `just e2e-pw` defaults to 4). |
| `GITMINI_E2E_HEADED=1` | Visible browser window. |
| `GITMINI_CHROME_BIN` | Browser executable. |
| `GITMINI_BRIDGE_BINARY`, `GITMINI_DIST_DIR` | Bridge binary (default `target/debug/gitmini-bridge`) and frontend folder (default `dist`). |
| `GITMINI_E2E_ARTIFACTS` | Parent folder of run artifacts (default `tests/playwright/.artifacts`). |
| `GITMINI_E2E_KEEP_TMP=1` | Keep the temporary repositories for investigation. |
| `GITMINI_E2E_NO_SANDBOX=1` | Pass `--no-sandbox` to Chrome (automatic when running as root). |

## Writing a spec

A spec is `specs/<scenario-id>.<fixture>.spec.ts`, for example `ui-12.with-remote.spec.ts`. The file name carries the scenario id (artifact folders are named after it); the fixture is chosen with `test.use`.

```ts
import { expect, test } from '../support';
import { setup } from './ui-12.with-remote.setup';

test.use({ scenario: { fixture: 'with-remote', setup } });   // `setup` is optional

test('UI-12 - ...', async ({ app, repo }) => {
  await app.click('sidebar-folder-item', { scope: 'local', folder: 'epic' });
  await expect(app.byTid('sidebar-branch-item', { ref: 'refs/heads/epic/login' })).toBeHidden();
  await app.press('Mod+K');
  await app.idle();
  expect(repo.currentBranch()).toBe('main');
});
```

Rules, enforced by `just lint` and `just check-test-policy`: no `.only`, `.skip`, `.fixme`, `test.fail()` or retries; no fixed waits (`page.waitForTimeout`, `setTimeout`): wait on a condition with `expect(...)` (auto-retrying), `expect.poll(...)`, `app.waitFor`, `app.idle()`. Select by `data-testid` and `data-*` attributes, never by class or text (except to check a wording). After a UI action, call `app.idle()` before asserting git state.

### Setups: custom repository states

A setup prepares the repository before the bridge starts. It has the contract of the WebdriverIO `*.setup.ts` files: `(fx, ctx) => void | env | { env?, args?, cleanup?, mock? }`.

```ts
import type { SetupFn } from '../support';
import { recentEntry, writeSettings } from '../support/settings';

export const setup: SetupFn = async (fx, ctx) => {
  fx.git('branch', 'bugfix/crash', 'main');                 // git in the repository
  writeSettings(ctx.settingsPath, { recent: [recentEntry(fx.other, 'other')] });
  return { env: { GITMINI_WATCH_DEBOUNCE_MS: '50' } };      // extra bridge environment
  // return { args: [] } to start the bridge without a repository path
  // return { env: mock.env(), mock } to wire a GitHub mock (closed with the test)
};
```

Put it next to the spec (`<id>.<fixture>.setup.ts`) and pass it explicitly with `test.use`. `fx` is the `PreparedFixture` of [`tests/support/fixture.ts`](../support/fixture.ts): `fx.git(...)`, `fx.gitIn(dir, ...)`, `fx.repo`, `fx.origin`, `fx.other`, `fx.dir(name)`, `fx.home`, `fx.root`. Import `../support/settings` (standalone) rather than `../support` from a setup that only needs settings helpers.

## API

### Fixtures (`import { test } from '../support'`)

| Fixture | Scope | What it is |
| --- | --- | --- |
| `repo` | test | `Repo`: isolated copy of the fixture, plus git helpers. Created from `test.use({ scenario })`; the setup has run. Alone it starts no process (use it for pure git/setup checks). |
| `bridge` | test | Handle of the `gitmini-bridge` process (own free port, `--port 0`): `url`, `restart(opts)`, `logFiles()`. Killed with its process group on teardown. |
| `app` | test | `App`: `page` on that bridge, repository opened, graph rendered, plus the helpers below. After a passing test it asserts there is no residual `*.lock` and that `git fsck` is clean; after a failing one it attaches the bridge logs and the browser console. |
| `page`, `context`, ... | test | Playwright built-ins (viewport 1280x800, scale 1, `en-US`, UTC, light). |

`test.use({ scenario: { fixture: string, setup?: SetupFn } })` is required. (One object, because Playwright would run a function-valued option such as `setup` as a fixture function.)

### `Repo` (`repo` and `app.repo`)

`path`, `fixture`, `root`, `home`, `origin`, `other`, `configDir`, `settingsPath`, `fx`, `session`, `mock`; `requireMock(): GithubMock`; `git(...args): string` (throws `GitError` with stderr), `gitIn(dir, ...args): string`, `gitOk(...args): { status, stdout, stderr }`, `head()`, `currentBranch()`, `refs()`, `state()`, `readSettings()`, `openedUrls()`.

Everything in [`tests/support/git-state.ts`](../support/git-state.ts) is also exported from `../support` and takes a path: `currentBranch(repo.path)`, `git(repo.path, ...)`, `revParse`, `logSubjects`, `stashList`, `inProgress`...

### `App` (`app`)

Selectors follow [`tests/support/ui.ts`](../support/ui.ts): `id` is a `data-testid` (it may carry `[data-x=y]` filters) and `attrs` adds `data-<key>="<value>"` filters (`{ stopReason: 'empty' }` is `[data-stop-reason="empty"]`). Action helpers target exactly one element (strict mode); use `app.byTid(id, attrs).first()` when several are expected.

| Method | Notes |
| --- | --- |
| `page`, `repo`, `url`, `settingsPath`, `pageErrors`, `consoleMessages` | Uncaught page exceptions and console lines of the page. |
| `ready({ graph? })`, `open()`, `idle()`, `restart({ env?, args? })` | `idle()` is `__gitmini.idle`. `restart` stops and starts the bridge on the same repository and settings, then reloads. |
| `byTid(id, attrs?)`, `visibleByTid(id, attrs?)` | `Locator`s: use with `expect(...)`. |
| `waitFor(id, attrs?)`, `waitGone(id, attrs?)` | First displayed element / no displayed element. |
| `count`, `attrsOf(id, name, attrs?)`, `text`, `attr`, `value`, `isShown` | Reads. Prefer `expect(locator).toHaveText/toHaveValue/toHaveCount`, which retry; `attrsOf` returns an attribute of every match in DOM order (`expect.poll(() => app.attrsOf('sidebar-branch-item', 'data-ref'))`). |
| `click`, `doubleClick`, `rightClick`, `clickInRow(rowId, path, buttonId)` | |
| `type(id, text, { attrs?, clear?, sequentially? })`, `typeKeys(text)` | `type` fills (replaces); `sequentially` types key by key; `typeKeys` types into whatever has focus. |
| `press(...chords)` | `Mod+K`, `Mod+Shift+Enter`, `Escape`, `ArrowDown`, `/`. `Mod` is Cmd on macOS and Ctrl elsewhere. Letters are lower-cased; write `Shift` explicitly. |
| `activeTestId()`, `activeData(name)`, `focusInside(testid)` | Focus inspection. |
| `contextAction(id, action, attrs?)`, `chooseContextItem(action)`, `contextMenuActions()` | Context menus. |
| `confirmDialog(action)`, `cancelDialog(action)` | `confirm-dialog[data-action=...]`. |
| `toast(kind, text?)`, `waitForToast(kind, text?)` | `kind`: `info`, `success`, `error`, `undo`. |
| `openPalette(text?)`, `paletteNames()` | Mod+K and the items' `data-label`. |
| `readSettings()` | `settings.json` as the application wrote it. |

Other exports: `tid`, `chord`, `Attrs`, `gitAsync` (any git command that talks to a GitHub mock must be async: the mock runs in the test process), `startMock`, `GithubMock`, `readSettingsFile`, `writeSettings`, `recentEntry` (also in `../support/settings`).

## Porting a WebdriverIO spec

Copy `tests/e2e/specs/<id>.<fixture>.e2e.ts` to `tests/playwright/specs/<id>.<fixture>.spec.ts` and its setup next to it, then translate:

| WebdriverIO | Playwright |
| --- | --- |
| `describe`/`it`, `currentSession()` | `test.describe`/`test`, `({ app, repo })`; `test.use({ scenario })` |
| `import ... from '../helpers'`, `SetupFn` | `import ... from '../support'` |
| `appReady()` | automatic (the `app` fixture); `app.ready({ graph: false })` is called for you when the bridge starts without a path |
| `restartApp()` | `app.restart()` |
| `click`, `doubleClick`, `typeInto`, `press`, `idle` | `app.click`, `app.doubleClick`, `app.type`, `app.press`, `app.idle` |
| `waitForTestId(id, { attrs })` / `waitForGone` | `app.waitFor(id, attrs)` / `app.waitGone(id, attrs)` |
| `expect(await textOf(id)).toBe(x)` | `await expect(app.byTid(id)).toHaveText(x)` |
| `expect(await countOf(id)).toBe(n)` | `await expect(app.byTid(id)).toHaveCount(n)` |
| `until(cond, { message })` | `await expect.poll(cond, { message }).toBe(...)` or an `expect(locator)` assertion |
| `browser.execute(fn)` | `app.page.evaluate(fn)` |
| `browser.keys([...])` | `app.typeKeys(text)` / `app.press(...)` |
| `currentBranch(repo)` (support/git-state) | `repo.currentBranch()` or `currentBranch(repo.path)` |
| `readSettings()` (ui-support) | `app.readSettings()` |
| `currentMock()`, `readOpenedUrls(session)` | `repo.requireMock()`, `repo.openedUrls()` |
| One `it` per file, state shared by successive `it`s | Each `test` starts from a fresh fixture copy: merge dependent steps into one test or give each its own setup |

## Layout

| Path | Role |
| --- | --- |
| `playwright.config.ts` | Rules in one place: no retries, 30 s per test, 10 s per condition, `fullyParallel`, traces and screenshots on failure, artifacts in the run folder. |
| `support/global-setup.ts`, `global-teardown.ts` | Prerequisite check (nothing is built implicitly), run folder and `gitmini-e2e-<runId>` TMPDIR marker; at the end: ghost processes, token scan, temp cleanup. A problem fails the run. |
| `support/fixtures.ts` | `repo`, `bridge`, `app`. |
| `support/app.ts`, `repo.ts`, `selectors.ts`, `settings.ts` | The helpers documented above. |
| `support/browser.ts` | Which Chrome. |
| `support/shared.ts` | The only file importing from `tests/e2e/helpers` (run marker, process tracking, session, `BridgeRunner`) and `tests/support`. Repoint it if the WebdriverIO harness is retired. |
| `support/mock-app.ts` | The `?mock=1` demo page: starts `vite` once per worker, `mockTest` and `MockApp` (see below). Does not use `repo`, `bridge` or `app`. |
| `helpers/` | Code shared by several specs of one feature (`linediff-*`, `mp-*`, `pal-ui`, `hist-support`, `rsv-af-support`, `tagtrash-ui`). Type-checked and linted like `support/` and `specs/`. `hist-support.ts` also imports `tests/e2e/specs/history-support.ts`, so that file must move here if the WebdriverIO harness is retired. |
| `specs/` | `pw-01` (harness smoke), `pw-02` (GitHub mock smoke), `mock-smoke` (the `?mock=1` journeys), then one `<id>.<fixture>.spec.ts` per scenario (ports of the WebdriverIO ones, and extra ones such as `rsv-02`..`rsv-06`, `af-02`..`af-04`, `tag-03`, `tag-04`, `mp-03`..`mp-09`, `pal-03`..`pal-08`). |

## Mock mode (`?mock=1`)

`specs/mock-smoke.spec.ts` drives the frontend on its in-memory transport (`src/lib/mock/transport.ts`, the demo data of `pnpm dev` and `http://localhost:1420/?mock=1`), with no repository, bridge or git. The mock exists only in the development build, never in `dist/`, so the spec cannot use the bridge: the `devServer` fixture of `support/mock-app.ts` starts `vite` on a free port once per worker (recorded in `pids.jsonl`, stopped with its process group). One journey per feature, each opening the screens a person would open (`mock.open('folders')`, `mock.open('conflict')` for the scenarios). The `mock` fixture fails a passing test whose page logged a console error or warning, threw, or requested a missing file, so a journey proves the feature works without a backend and that it stays silent. A command the mock does not simulate shows up as an error toast, not as a console error: add its handler to the transport.

## Artifacts and process hygiene

Everything of a run goes under `tests/playwright/.artifacts/run-<id>/` (gitignored):

- `run.json`, `pids.jsonl`, `summary.json`, `junit/results.xml` (and `html/` when `CI` is set);
- `pw-results/<test>/`: Playwright's screenshot, `trace.zip` and `error-context.md` of failed tests;
- `<SCENARIO>--<test>/`: the harness failure artifacts shared with WebdriverIO: `git-state.json`, `test.json`, `logs/` (bridge log, open-URL log), and `tmpdir.tar.zst` (archive of the temporary repository, skipped when it is large).

Each run has its own `$TMPDIR/gitmini-e2e-<runId>`; its name is on the command line of every process the run starts (`gitmini-bridge`, `git`, hooks), and bridge pids are recorded in `pids.jsonl`. The global teardown fails the run and kills any survivor, even after a crashed worker; `node scripts/check-ghosts.mjs --artifacts tests/playwright/.artifacts` is the independent check that `just e2e-pw` runs last. Traces can contain the bridge's network traffic; the GitHub scenarios only ever see the mock's fake tokens, and the teardown scans every other artifact for token patterns.
