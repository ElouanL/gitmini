// STAGE-10: `lines.txt` (12 lines) is committed, then three single-line replacements (3, 5 and 7) are left in the worktree:
// one hunk with three "- / +" pairs.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupFn } from '../support';
import { numberedFile } from '../helpers/linediff-patch';

export const setup: SetupFn = (fx) => {
  writeFileSync(join(fx.repo, 'lines.txt'), numberedFile());
  fx.git('add', 'lines.txt');
  fx.git('commit', '-q', '-m', 'add lines.txt');
  writeFileSync(join(fx.repo, 'lines.txt'), numberedFile({ 3: 'three', 5: 'five', 7: 'seven' }));
};
