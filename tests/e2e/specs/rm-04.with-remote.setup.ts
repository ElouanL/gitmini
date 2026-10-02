// RM-04: hand = origin/main (followed up to date), local commit, then other growths a commit only the main restitory has split not.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupFn } from '../helpers';

export const setup: SetupFn = async (fx) => {
  fx.git('merge', '-q', '--ff-only', 'origin/main');
  fx.git('commit', '-q', '--allow-empty', '-m', "local: commit to push");
  writeFileSync(join(fx.other, 'other-rm04.txt'), 'rm-04\n');
  fx.gitIn(fx.other, 'add', 'other-rm04.txt');
  fx.gitIn(fx.other, 'commit', '-q', '-m', "other: commit not split");
  fx.gitIn(fx.other, 'push', '-q', 'origin', 'main');
};
