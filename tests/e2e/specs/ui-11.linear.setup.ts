import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupFn } from '../helpers';
import { writeSettings } from './ui-support';

export const setup: SetupFn = (fx, ctx) => {
  // Enough history to verify repository of a nonzero graph scroll position.
  for (let i = 0; i < 60; i++) fx.git('commit', '--allow-empty', '-m', `Tab history ${i}`);
  const other = join(fx.root, 'tabs-other');
  fx.git('worktree', 'add', '--detach', other, 'HEAD');
  writeFileSync(join(fx.repo, 'tabs-a.txt'), 'Changes in A\n');
  writeFileSync(join(other, 'tabs-b.txt'), 'Changes in B\n');
  writeSettings(ctx.settingsPath, { 'workspace.tabs': { paths: [fx.repo, other], activePath: fx.repo } });
  return { args: [] };
};
