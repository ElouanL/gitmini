// MP-03: the application is told it runs git 2.37.1 (a recording shim in front of the real git, which still runs every command but
// `git --version`): older than the 2.38 that `git merge-tree --write-tree` needs.
import { installGitShim } from '../helpers/mp-git-shim';
import type { SetupFn } from '../support';

export const setup: SetupFn = (_fx, ctx) => ({ env: installGitShim(ctx, { version: '2.37.1' }).env });
