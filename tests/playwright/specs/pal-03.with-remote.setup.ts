// PAL-03: a hand-edited `palette.recent` in settings.json (the second test; the first one starts without any).
// Ten ids, in the order of most recent first: a command that exists but is not available (nothing to pop), one that no longer exists, a
// repeated one, and two beyond the eight the palette remembers (`tag.create`, `settings.open`).
import type { SetupFn } from '../support';
import { writeSettings } from '../support/settings';

export const HAND_EDITED = [
  'stash.pop', 'removed.command', 'branch.create', 'git.fetch', 'view.reflog', 'git.fetch', 'graph.search', 'sidebar.filter', 'theme.toggle', 'tag.create', 'settings.open',
];

export const setup: SetupFn = (_fx, ctx) => {
  writeSettings(ctx.settingsPath, { 'palette.recent': HAND_EDITED });
};

/** Not valid (a number among the ids): the backend ignores the whole key and the palette starts without memory. */
export const setupInvalid: SetupFn = (_fx, ctx) => {
  writeSettings(ctx.settingsPath, { 'palette.recent': ['git.fetch', 42] });
};
