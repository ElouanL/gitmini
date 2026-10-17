// UI-12 (accessibility and extra filter coverage): the branches and tags of UI-12 plus two stashes, so that the stash list is
// there to be narrowed too (with none, "the stash section leaves" proves nothing).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupFn } from '../support';
import { setup as prefixed } from './ui-12.with-remote.setup';

export const setup: SetupFn = async (fx, ctx) => {
  await prefixed(fx, ctx);
  writeFileSync(join(fx.repo, 'file-1.txt'), 'wip of the login form\n');
  fx.git('stash', 'push', '-q', '-m', 'wip login form');
  writeFileSync(join(fx.repo, 'file-2.txt'), 'wip of the checkout fix\n');
  fx.git('stash', 'push', '-q', '-m', 'wip checkout fix');
};
