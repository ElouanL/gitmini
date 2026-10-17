// PAL-07: the application starts without a repository (as `gitmini` with no path and an empty list of remembered tabs: without that list it
// would reopen the most recent repository), and the collaborator's clone is the one recent repository.
import type { SetupFn } from '../support';
import { recentEntry, writeSettings } from '../support/settings';

export const setup: SetupFn = (fx, ctx) => {
  writeSettings(ctx.settingsPath, { recent: [recentEntry(fx.other, 'other')], 'workspace.tabs': { paths: [], activePath: null } });
  return { args: [] };
};
