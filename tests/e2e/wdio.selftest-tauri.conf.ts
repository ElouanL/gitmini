// Autotest of the tauri-driver path of the without binary harness Tauri or WebKitWebDriver: a false tauri-driver
// (selftest/fake-tauri-driver.mjs) proxifies to chromiumdriver. Proves the mutation of capabilities (hostname, port,
// tauri:options) in beforeSession, the legacy of the environment, reloadSession and restartApp.
// development of the harness (Chrome required: GITMINI_CHROME_BIN if absent); does not turn into CI.
//
//   pnpm --dir tests/e2e run selftest # first : WDIO download chromedriver
//   pnpm --dir tests/e2e run selftest:tauri
import { join } from 'node:path';
import { createConfig } from './helpers/config';
import { e2eDir } from './helpers/paths';

process.env.GITMINI_TAURI_DRIVER ??= join(e2eDir, 'selftest', 'fake-tauri-driver.mjs');
process.env.GITMINI_BINARY ??= process.execPath; // the "application" must exist: the false driver ignores it

export const config = createConfig({ mode: 'tauri', platform: 'linux', specs: join(e2eDir, 'selftest', 'tauri') });
