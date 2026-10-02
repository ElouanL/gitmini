// Setup of ROB-04: a change followed, of which stasher.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupFn } from '../helpers';

export const setup: SetupFn = (fx) => {
  appendFileSync(join(fx.repo, 'file-2.txt'), "to be handed over\n");
};
