// PAL-02: the collaborator's clone is a recent repository (as if the user had opened it before), to open from the palette.
import type { SetupFn } from '../helpers';
import { recentEntry, writeSettings } from './ui-support';

export const setup: SetupFn = (fx, ctx) => {
  writeSettings(ctx.settingsPath, { recent: [recentEntry(fx.other, 'other')] });
};
