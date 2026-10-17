// PAL-02: the collaborator's clone is a recent repository (as if the user had opened it before), to open from the palette; and the
// collaborator has pushed one more commit to origin, so that a Fetch run from the palette has something to bring in.
import type { SetupFn } from '../support';
import { recentEntry, writeSettings } from '../support/settings';

export const setup: SetupFn = (fx, ctx) => {
  writeSettings(ctx.settingsPath, { recent: [recentEntry(fx.other, 'other')] });
  fx.gitIn(fx.other, 'commit', '--allow-empty', '-q', '-m', 'origin: pushed after the last fetch');
  fx.gitIn(fx.other, 'push', '-q', 'origin', 'main');
};
