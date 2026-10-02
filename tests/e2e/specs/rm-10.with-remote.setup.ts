// RM-10: Other and the main repository modify the same line of file-1.txt (the pull rebase from hand to hand conflicts).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupFn } from '../helpers';

export const setup: SetupFn = async (fx) => {
  writeFileSync(join(fx.other, 'file-1.txt'), 'version de other\n');
  fx.gitIn(fx.other, 'add', 'file-1.txt');
  fx.gitIn(fx.other, 'commit', '-q', '-m', 'other: modifie file-1.txt');
  fx.gitIn(fx.other, 'push', '-q', 'origin', 'main');

  writeFileSync(join(fx.repo, 'file-1.txt'), 'version locale\n');
  fx.git('add', 'file-1.txt');
  fx.git('commit', '-q', '-m', 'local: modifie file-1.txt');
};
