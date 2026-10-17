// AF-01: the collaborator pushes 1 commit on main that the main repository has not fetched (it is already 2 behind).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupFn } from '../helpers';

export const setup: SetupFn = async (fx) => {
  writeFileSync(join(fx.other, 'origin3.txt'), 'origin 3\n');
  fx.gitIn(fx.other, 'add', 'origin3.txt');
  fx.gitIn(fx.other, 'commit', '-q', '-m', 'origin: add origin3.txt');
  fx.gitIn(fx.other, 'push', '-q', 'origin', 'main');
};
