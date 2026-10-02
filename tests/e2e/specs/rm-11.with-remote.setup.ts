// RM-11: hand = origin/hand, local commit to push, and pre-push hook that refuses.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { SetupFn } from '../helpers';

export const setup: SetupFn = async (fx) => {
  fx.git('merge', '-q', '--ff-only', 'origin/main');
  fx.git('commit', '-q', '--allow-empty', '-m', "local: commit to push");
  const hooksPath = fx.git('rev-parse', '--git-path', 'hooks');
  const hook = join(isAbsolute(hooksPath) ? hooksPath : resolve(fx.repo, hooksPath), 'pre-push');
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(hook, '#!/bin/sh\necho "tests ko" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
};
