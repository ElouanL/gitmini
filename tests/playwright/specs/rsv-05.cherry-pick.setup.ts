// RSV-05: `git cherry-pick topic` (T3, which modifies line 2 of g.txt like main did) stopped on conflict before the application opens.
import type { SetupFn } from '../support';
import { gitOk } from '../../support/git-state';

export const setup: SetupFn = async (fx) => {
  if (gitOk(fx.repo, 'cherry-pick', 'topic').status === 0) throw new Error('git cherry-pick topic had to stop on conflict (fixture cherry-pick)');
};
