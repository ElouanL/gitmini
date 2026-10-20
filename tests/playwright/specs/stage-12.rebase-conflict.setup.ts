// STAGE-12: `git merge feature` into `main` stopped on conflict.txt before the application opens, with a tracked file changed
// (README.md) and an untracked one (notes.txt) next to the conflict. feature2.txt merges cleanly and is already staged.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupFn } from '../support';
import { gitOk } from '../../support/git-state';

export const setup: SetupFn = async (fx) => {
  fx.git('switch', '-q', 'main');
  if (gitOk(fx.repo, 'merge', 'feature').status === 0) throw new Error('git merge feature had to stop on conflict.txt (fixture rebase-conflict)');
  writeFileSync(join(fx.repo, 'README.md'), '# Fixture gitmini, changed during the merge\n');
  writeFileSync(join(fx.repo, 'notes.txt'), 'notes\n');
};
