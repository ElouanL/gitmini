// STAGE-10 (several hunks): `lines.txt` has 40 lines; the worktree replaces line 3 and line 30 (far enough apart to be two
// hunks at the default three lines of context) and adds `extra` after line 31, so that the second hunk holds a replaced line
// and an added one.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupFn } from '../support';
import { numberedFile } from '../helpers/linediff-patch';

export const FORTY = 40;

export const setup: SetupFn = (fx) => {
  writeFileSync(join(fx.repo, 'lines.txt'), numberedFile({}, FORTY));
  fx.git('add', 'lines.txt');
  fx.git('commit', '-q', '-m', 'add lines.txt');
  writeFileSync(join(fx.repo, 'lines.txt'), numberedFile({ 3: 'three', 30: 'thirty', 31: 'line 31\nextra' }, FORTY));
};
