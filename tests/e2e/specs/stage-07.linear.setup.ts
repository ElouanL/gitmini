// STAGE-07: an executable pre-commit hook that refuses (`lint ko`), and a staged file to commit.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupFn } from '../helpers';
import { gitDir } from '../../support/git-state';

export const setup: SetupFn = (fx) => {
  const hooks = join(gitDir(fx.repo), 'hooks');
  mkdirSync(hooks, { recursive: true });
  const hook = join(hooks, 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\necho "lint ko" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  writeFileSync(join(fx.repo, 'new.txt'), "to be committed\n");
  fx.git('add', 'new.txt');
};
