// HEAD on feature, with an uncommitted change of README.md (worktree dirty: followed, thus blocking for rebase).
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupFn } from '../helpers';

export const setup: SetupFn = async (fx) => {
  fx.git('switch', 'feature');
  appendFileSync(join(fx.repo, 'README.md'), 'modification locale\n');
};
