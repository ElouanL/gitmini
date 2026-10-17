// MP-01: the `rebase-conflict` fixture has HEAD on feature; the merge goes the other way, feature into main. The application's
// git is a recording shim (the real git behind it), so the spec can tell which git commands the dry run ran.
import { installGitShim } from '../helpers/mp-git-shim';
import type { SetupFn } from '../support';

export const setup: SetupFn = (fx, ctx) => {
  fx.git('switch', 'main');
  return { env: installGitShim(ctx).env };
};
