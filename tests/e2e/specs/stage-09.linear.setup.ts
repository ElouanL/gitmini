// STAGE-09: neither user.name nor user.email in the HOME test (and `user.useConfigOnly`, otherwise git deduces an identity from
// system user); a staged file to commit.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupFn } from '../helpers';

export const setup: SetupFn = (fx) => {
  writeFileSync(join(fx.home, '.gitconfig'), '[user]\n\tuseConfigOnly = true\n');
  writeFileSync(join(fx.repo, 'new.txt'), "to be committed\n");
  fx.git('add', 'new.txt');
};
