// STAGE-06: nothing staged (`git reset`), the changes remain in the worktree.
import type { SetupFn } from '../helpers';

export const setup: SetupFn = (fx) => {
  fx.git('reset', '-q');
};
