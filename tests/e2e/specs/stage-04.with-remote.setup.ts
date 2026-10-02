// STAGE-04: `main` up to date of its upstream (origin/main), HEAD pushed. An unfollowed file shows the line WIP,
// only `commit-form` entry door (04: the WIP line only exists if there are files).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupFn } from '../helpers';

export const setup: SetupFn = (fx) => {
  fx.git('merge', '--ff-only', 'origin/main');
  writeFileSync(join(fx.repo, 'note.txt'), "file not tracked\n");
};
