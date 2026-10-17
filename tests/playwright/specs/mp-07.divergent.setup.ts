// MP-07: a branch `unrelated` that shares no history with main (its own root commit), next to the `divergent` fixture. HEAD stays on main.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupFn } from '../support';

export const setup: SetupFn = (fx) => {
  fx.git('switch', '-q', '--orphan', 'unrelated');
  writeFileSync(join(fx.repo, 'solo.txt'), 'alone\n');
  fx.git('add', 'solo.txt');
  fx.git('commit', '-q', '-m', 'unrelated: root commit');
  fx.git('switch', '-q', 'main');
};
