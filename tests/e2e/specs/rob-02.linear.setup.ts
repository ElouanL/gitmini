// Setup of ROB-02: Two modified followed files (unstaged): `git commit -am` will have something to commit.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupFn } from '../helpers';

export const setup: SetupFn = (fx) => {
  appendFileSync(join(fx.repo, 'file-3.txt'), 'modif a\n');
  appendFileSync(join(fx.repo, 'file-4.txt'), 'modif b\n');
};
