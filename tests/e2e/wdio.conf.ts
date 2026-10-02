// WebdriverIO + tauri-driver on the real Tauri binary (, §11.1): Linux (WebKitWebDriver) and Windows (msedgedriver).
// Deny macOS (no WKWebView driver) with the 13 message; under macOS, see `wdio.web.conf.ts`.
//
//   cargo tauri build --debug --features e2e --no-bundle      # ou `just e2e`
//   pnpm --dir tests/e2e exec wdio run wdio.conf.ts [--spec specs/rb-01.divergent.e2e.ts] [--shard 1/4]
//
// Variables : GITMINI_BINARY, GITMINI_TEST_SEED, GITMINI_E2E_ARTIFACTS, GITMINI_E2E_SKIP_LINUX_ONLY=1, GITMINI_NATIVE_DRIVER, GITMINI_TAURI_DRIVER,
// GITMINI_E2E_KEEP_TMP=1 (see helpers/*.ts). A file = a scenario = a fixture = a session.
import { join } from 'node:path';
import { createConfig } from './helpers/config';
import { e2eDir } from './helpers/paths';

export const config = createConfig({ mode: 'tauri', specs: join(e2eDir, 'specs') });
