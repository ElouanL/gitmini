// RB-08: HEAD on feature + hook `pre-rebase` sentinel: git remains stuck in the hook until the test releases it.
import { join } from 'node:path';
import type { SetupFn } from '../helpers';
import { installHook } from '../../support/sentinel';

export const setup: SetupFn = async (fx) => {
  fx.git('switch', 'feature');
  installHook(fx.repo, 'pre-rebase', join(fx.root, 'sentinels', 'pre-rebase'));
};
