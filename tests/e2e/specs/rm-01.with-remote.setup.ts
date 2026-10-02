// RM-01: the employee pushes 1 commit on hand and removes dev on origin; the main repository does not refetch.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupFn } from '../helpers';

export const setup: SetupFn = async (fx) => {
  writeFileSync(join(fx.other, 'origin3.txt'), 'origin 3\n');
  fx.gitIn(fx.other, 'add', 'origin3.txt');
  fx.gitIn(fx.other, 'commit', '-q', '-m', "origin: add origin3.txt");
  fx.gitIn(fx.other, 'push', '-q', 'origin', 'main');
  fx.gitIn(fx.other, 'push', '-q', 'origin', '--delete', 'dev');
};
