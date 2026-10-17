// Playwright harness for gitmini, additional to the WebdriverIO one (tests/e2e). Same application under test and same
// isolation rules: Chrome on the development bridge `gitmini-bridge` (crates/gitmini-bridge) serving `dist/`, one
// temporary copy of a fixture repository, HOME and `settings.json` per test, a `gitmini-e2e-<run>` marker on every process.
// Nothing is built here:
//
//   VITE_GITMINI_GITHUB_LOGIN=1 pnpm build        # frontend in dist/
//   cargo build -p gitmini-bridge
//   node tests/fixtures/build.mjs                 # fixtures in target/fixtures (also built on demand)
//   pnpm --dir tests/playwright exec playwright test [specs/ui-12.with-remote.spec.ts]
//   node scripts/check-ghosts.mjs --artifacts tests/playwright/.artifacts
//
// (`just e2e-pw` does all of it.) Variables: GITMINI_E2E_WORKERS (default 1), GITMINI_E2E_HEADED=1, GITMINI_CHROME_BIN,
// GITMINI_BRIDGE_BINARY, GITMINI_DIST_DIR, GITMINI_E2E_ARTIFACTS (default tests/playwright/.artifacts), GITMINI_E2E_KEEP_TMP=1.
// The rules live here and nowhere else: no retry (an unstable test is a bug), 30 s per test, 10 s per condition.

import { defineConfig, type ReporterDescription } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBrowser } from './support/browser';
import { artifactsRoot, ensureRunId } from './support/shared';
import { workerCount } from './support/workers';

// The shared run helpers read these variables: set them before the first call and before workers are forked (they inherit them).
process.env.GITMINI_E2E_ARTIFACTS ??= join(dirname(fileURLToPath(import.meta.url)), '.artifacts');
ensureRunId();

const browser = resolveBrowser();
const artifacts = artifactsRoot();
const reporter: ReporterDescription[] = [['list'], ['junit', { outputFile: join(artifacts, 'junit', 'results.xml') }]];
if (process.env.CI) reporter.push(['html', { open: 'never', outputFolder: join(artifacts, 'html') }]);

export default defineConfig({
  testDir: './specs',
  testMatch: '**/*.spec.ts',
  outputDir: join(artifacts, 'pw-results'),
  globalSetup: './support/global-setup.ts',
  globalTeardown: './support/global-teardown.ts',
  fullyParallel: true, // every test owns its repository, bridge and browser context
  forbidOnly: true,
  retries: 0,
  workers: workerCount(),
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter,
  use: {
    channel: browser.channel,
    headless: process.env.GITMINI_E2E_HEADED !== '1',
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      executablePath: browser.executablePath,
      args: ['--disable-gpu', '--no-first-run', ...(process.env.GITMINI_E2E_NO_SANDBOX === '1' || process.getuid?.() === 0 ? ['--no-sandbox'] : [])],
    },
  },
});
