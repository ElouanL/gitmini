// UI-12: application launched without path, with a plain folder (no repository) next to the fixture.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupFn } from '../helpers';
import { writeSettings } from './ui-support';

export const setup: SetupFn = async (fx, ctx) => {
  mkdirSync(join(fx.tmp, 'plain'), { recursive: true });
  writeSettings(ctx.settingsPath, { recent: [], 'workspace.tabs': { paths: [], activePath: null } });
  return { args: [] };
};
