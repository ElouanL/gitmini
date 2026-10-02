// UI-08: application launched without path, with a historical bare in recent (settings.json prepared before launch).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupFn } from '../helpers';
import { recentEntry, writeSettings } from './ui-support';

export const setup: SetupFn = async (fx, ctx) => {
  const bare = join(fx.tmp, 'bare.git');
  mkdirSync(bare, { recursive: true });
  fx.gitIn(bare, 'init', '-q', '--bare');
  writeSettings(ctx.settingsPath, { recent: [recentEntry(bare, 'bare.git')], 'workspace.tabs': { paths: [], activePath: null } });
  return { args: [] };
};
