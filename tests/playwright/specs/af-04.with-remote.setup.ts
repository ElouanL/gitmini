// AF-04: two tabs, `repo` (active) and `second`, a clone of the same origin made before the collaborator pushes 1 commit on main.
// Both are therefore behind origin/main without knowing it: `repo` by 3 commits, `second` by 1.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupFn } from '../support';
import { writeSettings } from '../support/settings';

export const setup: SetupFn = async (fx, ctx) => {
  const second = fx.dir('second');
  fx.gitIn(fx.root, 'clone', '-q', fx.origin, second);

  writeFileSync(join(fx.other, 'origin3.txt'), 'origin 3\n');
  fx.gitIn(fx.other, 'add', 'origin3.txt');
  fx.gitIn(fx.other, 'commit', '-q', '-m', 'origin: add origin3.txt');
  fx.gitIn(fx.other, 'push', '-q', 'origin', 'main');

  writeSettings(ctx.settingsPath, { 'workspace.tabs': { paths: [fx.repo, second], activePath: fx.repo } });
  return { args: [] };
};
