// PAL-08: 1300 more commits on top of the ten of `linear` ("bulk 0001" to "bulk 1300", one second apart, no file changed), so that the
// history is longer than what the graph loads at once (pages of 500 rows) and "commit 1" to "commit 10" are far below the top.
import { spawnSync } from 'node:child_process';
import { gitBinary } from '../../support/fixture';
import type { SetupFn } from '../support';

export const BULK = 1300;
const FIRST_SECOND = 1_800_000_100; // after the fixture's commits (1_800_000_000)

export const setup: SetupFn = (fx) => {
  const lines: string[] = [];
  for (let i = 1; i <= BULK; i++) {
    const subject = `bulk ${String(i).padStart(4, '0')}`;
    lines.push('commit refs/heads/main', `committer Fixture Bot <bot@fixtures.gitmini> ${FIRST_SECOND + i} +0000`, `data ${subject.length}`, subject);
    if (i === 1) lines.push('from refs/heads/main^0');
    lines.push('');
  }
  const run = spawnSync(gitBinary(), ['-C', fx.repo, 'fast-import', '--quiet'], { input: `${lines.join('\n')}\n`, env: fx.env, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git fast-import failed: ${run.stderr}`);
};
