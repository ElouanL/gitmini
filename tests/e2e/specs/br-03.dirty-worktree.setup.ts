// BR-03: a `other` branch that mod.txt (line 30) without touch the dirty worktree or HEAD.
// Line 30: away from the local 3 hunks (lines 4, 20 and 36), so reapplication of autostash does not produce conflict.
import type { SetupFn } from '../helpers';
import { createBranchCommit } from '../../support/git-state';

export const setup: SetupFn = async (fx) => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  lines[29] = 'line 30 (other)';
  createBranchCommit(fx.repo, { branch: 'other', files: { 'mod.txt': lines.join('\n') + '\n' }, message: 'other: modifie mod.txt' });
};
