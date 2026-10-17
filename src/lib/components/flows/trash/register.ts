// Domain "trash" (discarded files): the `discard-trash-panel` drawer next to the reflog, and the `view.discarded` action
// that opens it. `announceDiscard` (announce.ts) is what the discard flows call to point the user at it.
// The drawer loads lazily (initial JS budget).
import { t } from '$i18n/index';
import { registerAction } from '$lib/actions/registry';
import { registerDrawer } from '$lib/panels/registry';
import { TRASH_DRAWER } from './ids';

registerDrawer(TRASH_DRAWER, () => import('./DiscardTrashPanel.svelte'));

registerAction({
  id: 'view.discarded',
  label: () => t('trash.action.show'),
  disabledReason: (ctx) => (ctx.repoId === null ? t('action.noRepo') : null),
  run: (ctx) => ctx.ui.toggleDrawer(TRASH_DRAWER),
});
