// MP-02: `divergent` has HEAD on main already. The application's git is a recording shim (the real git behind it), so the spec can
// tell that a fast-forward never asks `git merge-tree` anything.
import { installGitShim } from '../helpers/mp-git-shim';
import type { SetupFn } from '../support';

export const setup: SetupFn = (_fx, ctx) => ({ env: installGitShim(ctx).env });
