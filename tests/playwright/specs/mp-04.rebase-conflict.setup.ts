// MP-04: same shim as MP-03 (the application believes git is 2.37.1), on the fixture whose merge conflicts. HEAD goes on main.
import { installGitShim } from '../helpers/mp-git-shim';
import type { SetupFn } from '../support';

export const setup: SetupFn = (fx, ctx) => {
  fx.git('switch', 'main');
  return { env: installGitShim(ctx, { version: '2.37.1' }).env };
};
