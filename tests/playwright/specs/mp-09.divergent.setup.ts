// MP-09: the branches of MP-05 (`topic` conflicts with main on three files, `feature` merges cleanly), and the application's git is a shim
// that keeps the first `git merge-tree` waiting until the spec lets it go: the preview of the first branch answers late.
import { installGitShim } from '../helpers/mp-git-shim';
import type { SetupFn } from '../support';
import { setup as conflictingBranch } from './mp-05.divergent.setup';

export const setup: SetupFn = async (fx, ctx) => {
  await conflictingBranch(fx, ctx);
  return { env: installGitShim(ctx, { holdFirstMergeTree: true }).env };
};
