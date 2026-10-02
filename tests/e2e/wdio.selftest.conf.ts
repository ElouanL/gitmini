// Autotest of the harness : a static page (seftest/page/) served by the harness plays the role of the application. Prove, without
// gitmini binary: isolated fixture, setup.ts, WebDriver session, chess artifacts, git locks, Pointer Events of drag-
// drop, restart (`restartApp`, `reloadSession`), random order. Requires Chrome (GITMINI_CHROME_BIN if absent).
//
//   pnpm --dir tests/e2e run selftest
import { join } from 'node:path';
import { createConfig } from './helpers/config';
import { e2eDir } from './helpers/paths';

export const config = createConfig({ mode: 'selftest', specs: join(e2eDir, 'selftest', 'specs') });
