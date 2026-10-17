// Runs once, in the Playwright main process, before any worker: checks that everything the tests need is already built
// (nothing is built implicitly), then starts the run the way WebdriverIO's `onPrepare` does. `initRun` creates the run's
// temporary folder `$TMPDIR/gitmini-e2e-<runId>` and makes it the TMPDIR of every worker (workers are started after this
// function returns and inherit the environment), so every process of the run carries the marker that check-ghosts looks for.

import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { resolveBrowser } from './browser';
import { artifactsRoot, assertDiskSpace, bridgeBinary, distDir, initRun, root } from './shared';

export default async function globalSetup(): Promise<void> {
  const bridge = bridgeBinary();
  const dist = distDir();
  const browser = resolveBrowser();
  const missing: string[] = [];
  if (!existsSync(bridge)) missing.push(`gitmini-bridge not found: ${bridge}\n    build it: cargo build -p gitmini-bridge (or set GITMINI_BRIDGE_BINARY)`);
  if (!existsSync(join(dist, 'index.html'))) missing.push(`frontend not built: ${join(dist, 'index.html')}\n    build it: VITE_GITMINI_GITHUB_LOGIN=1 pnpm build (or set GITMINI_DIST_DIR)`);
  if (!browser.channel && !browser.executablePath && !existsSync(chromium.executablePath())) {
    missing.push('no Chrome found\n    install one browser: pnpm --dir tests/playwright exec playwright install chromium (or set GITMINI_CHROME_BIN to a Chrome/Chromium/Brave binary)');
  }
  if (missing.length > 0) throw new Error(`Playwright harness prerequisites missing:\n  - ${missing.join('\n  - ')}\n(or run: just e2e-pw)`);

  assertDiskSpace(tmpdir());
  const artifacts = artifactsRoot();
  mkdirSync(artifacts, { recursive: true });
  // the run folder is unique per run; only a reused GITMINI_E2E_RUN_ID can leave records of a previous run behind
  for (const stale of ['pids.jsonl', 'summary.json']) rmSync(join(artifacts, stale), { force: true });
  const run = initRun({ seed: 0, mode: 'web', binary: null, bridgeBinary: bridge });
  console.log(`\n[harness playwright] browser: ${browser.source}`);
  console.log(`[harness playwright] run tmp: ${run.tmpBase} ; artifacts: ${relative(root, artifacts) || artifacts}`);
}
