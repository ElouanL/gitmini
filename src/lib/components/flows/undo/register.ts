// Domain "undo and Security" (11): `undo-confirm-dialog`, drawer `reflog-panel`, warning LFS.
// `toolbar-undo-btn` / `Mod+Z` go through the `undo.last` action of the base, which opens `undo-confirm-dialog` if recorded.
// `offerUndo` (offer-undo.ts) is the contract that other domains call after a write-out that can be cancelled.
// Dialogue and drawer are sluggish loading (initial JS budget, `pnpm size`).
import { registerDialog } from '$lib/dialogs/registry';
import { registerDrawer } from '$lib/panels/registry';
import { startSafetyWatchers } from './safety.svelte';

registerDialog('undo-confirm-dialog', () => import('./UndoConfirmDialog.svelte'));
registerDrawer('reflog-panel', () => import('./ReflogPanel.svelte'));
startSafetyWatchers();
