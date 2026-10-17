// Runs once after the last test (also after a failed or interrupted run): the end-of-job checks of WebdriverIO's `onComplete`.
// A failure here fails the run even when every test passed.
//   1. no process started by the run survives (marker `gitmini-e2e-<runId>` in its command line, pids recorded in pids.jsonl,
//      and their descendants); survivors are listed and killed
//   2. no GitHub token in the artifacts, nor in a test's temporary folder (token-leak.json)
//   3. housekeeping: the temporary folders are removed (`GITMINI_E2E_KEEP_TMP=1` keeps them)
// Playwright's own outputs (traces are zip files, screenshots are images) are not scanned for tokens.

import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  artifactsRoot, formatGhosts, killGhosts, pidsFile, readPidsFile, readRun, removeRunTmp, scanDirForTokens, waitForNoGhosts,
} from './shared';

export default async function globalTeardown(): Promise<void> {
  const run = readRun();
  const artifacts = artifactsRoot();
  const problems: string[] = [];

  if (run) {
    // never by executable name: another run (another agent, another terminal) may use the same binary
    const ghosts = await waitForNoGhosts({ marker: run.marker, recorded: readPidsFile(pidsFile()), waitMs: 3000 });
    if (ghosts.length > 0) {
      problems.push(`${ghosts.length} process(es) started by the tests survived`);
      console.error(`\n[harness playwright] ghost processes:\n${formatGhosts(ghosts)}`);
      await killGhosts(ghosts);
    }
  }

  const leaks = scanDirForTokens(artifacts, { skipDirs: ['pw-results', 'html'] }).filter((h) => !h.file.endsWith('.tar.zst') && !h.file.endsWith('.tar.gz'));
  for (const hit of leaks) problems.push(`token ${hit.prefix}... in the artifact ${relative(artifacts, hit.file)}`);
  for (const dir of existsSync(artifacts) ? readdirSync(artifacts) : []) {
    const leak = join(artifacts, dir, 'token-leak.json');
    if (existsSync(leak)) problems.push(`token found in the temporary folder of ${dir} (see ${relative(artifacts, leak)})`);
  }

  if (run && existsSync(run.tmpBase) && process.env.GITMINI_E2E_KEEP_TMP !== '1') {
    const left = readdirSync(run.tmpBase).filter((n) => n.startsWith('gitmini-test-'));
    if (left.length > 0) console.warn(`[harness playwright] temporary folders not removed by the tests: ${left.join(', ')}`);
    removeRunTmp(run);
  }

  if (run) writeFileSync(join(artifacts, 'summary.json'), `${JSON.stringify({ mode: 'playwright', problems, finishedAt: Date.now() }, null, 2)}\n`);
  if (problems.length > 0) throw new Error(`[harness playwright] end-of-run check failed:\n  - ${problems.join('\n  - ')}`);
}
