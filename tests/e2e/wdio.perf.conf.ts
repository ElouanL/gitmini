// WebdriverIO performance measurements (, ) : binary `release-perf`, tauri-driver, without the `window.__gitmini` bridge
// (measures read `GITMINI_PERF_TRACE` and DOM). One file, tests/perf/perf.e2e.ts, changes the fixture with
// `restartApp`. Linux and Windows; under macOS, `just perf` only launches tests/perf/startup.mjs.
//
//   cargo tauri build --features e2e --no-bundle -- --profile release-perf
//   GITMINI_BINARY=target/release-perf/gitmini pnpm --dir tests/e2e exec wdio run wdio.perf.conf.ts [--mochaOpts.grep PERF-14]
//
// Variables : GITMINI_BINARY, GITMINI_PERF_NIGHTLY=1 (mesures nightly), GITMINI_PERF_LINUX=1 (colonne LINUX), GITMINI_PERF_FIXTURE.
import { join } from 'node:path';
import { createConfig } from './helpers/config';
import { root } from './helpers/paths';

export const config = createConfig({ mode: 'perf', specs: [join(root, 'tests', 'perf', 'perf.e2e.ts')] });
