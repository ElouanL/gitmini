// UI-07 (@linux-only: fake `git` in script sh): a `git` that answers "git version 2.25.1" at the top of the application's PATH.
// The PATH contains only this folder and /usr/bin:/bin: the true git of the machine is never reached by the application.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupFn } from '../helpers';

export const setup: SetupFn = async (fx) => {
  const fake = join(fx.tmp, 'fake-git');
  mkdirSync(fake, { recursive: true });
  const script = join(fake, 'git');
  writeFileSync(script, '#!/bin/sh\necho "git version 2.25.1"\n');
  chmodSync(script, 0o755);
  // /bin alone (not /usr/bin): under macOS as under Linux the system `git` is not in /bin
  return { PATH: `${fake}:/bin` };
};
