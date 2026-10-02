// Setup of ROB-10: hook `pre-commit` sentinel . He writes `<sentinelle>.reached` then waits for `<sentinelle>`
// exists; spec finds it at `<tmp>/sentinels/pre-commit`.
import { join } from 'node:path';
import { installHook } from '../../support/sentinel';
import type { SetupFn } from '../helpers';

export const setup: SetupFn = (fx) => {
  installHook(fx.repo, 'pre-commit', join(fx.root, 'sentinels', 'pre-commit'));
};
