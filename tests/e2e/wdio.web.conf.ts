// Browser variant: same rules and specs as `wdio.conf.ts`, but the "browser" is Chrome (chromedriver managed
// by WebdriverIO) pointed to the development bridge `gitmini-bridge` (crates/gitmini-bridge), which serves the front and backend
// `beforeSession` launches it with the same environment as `tauri-driver` (HOME fixture, GITMINI_*). This is the average
// run the suite locally under macOS; it does not replace the e2e of the binary Tauri (no CSP or capabilities).
//
//   pnpm built # front in dist/ (pecs need build e2e: bridge activates)
//   cargo build -p gitmini-bridge
//   pnpm --dir tests/e2e exec wdio run wdio.web.conf.ts [--spec specs/rb-01.divergent.e2e.ts]
//
// Variables: GITMINI_BRIDGE_BINARY, GITMINI_DIST_DIR, GITMINI_CHROME_BIN (Chrome/Chromium/Brave if Chrome is not installed),
// GITMINI_E2E_HEADED=1 (visible window), GITMINI_TEST_SEED, GITMINI_E2E_ARTIFACTS, GITMINI_E2E_KEEP_TMP=1.
import { join } from 'node:path';
import { createConfig } from './helpers/config';
import { e2eDir } from './helpers/paths';

export const config = createConfig({ mode: 'web', specs: join(e2eDir, 'specs') });
