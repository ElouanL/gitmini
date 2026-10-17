// MP-08: an uncommitted change to README.md (tracked, untouched by either branch) in the `divergent` fixture, HEAD on main.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupFn } from '../support';

export const setup: SetupFn = (fx) => {
  appendFileSync(join(fx.repo, 'README.md'), 'my unfinished note\n');
};
