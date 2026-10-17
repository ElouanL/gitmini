// Domain "file history": the `file-history` center view (list of the commits that changed a file, their changes, blame), the
// entries of the file menus that open it, and the palette actions. Imported automatically on startup (`register-domains.ts`).
// The view loads lazily (initial JS budget); this module imports no component.
import { registerAction, type ActionContext } from '$lib/actions/registry';
import type { MenuTargetOf } from '$lib/menus/types';
import { registerMenuItems } from '$lib/menus/registry';
import { registerCenterView } from '$lib/panels/registry';
import { t } from '$i18n/index';
import { historyPathOf } from './history-logic';
import { FILE_HISTORY_VIEW } from './ids';
import { currentFile, openFileHistory } from './open';

registerCenterView(FILE_HISTORY_VIEW, () => import('./FileHistoryView.svelte'));

// - - Menu `wt-file`: one file at a time, under the name it has in HEAD - -
function wtPath(target: MenuTargetOf<'wt-file'>): string | null {
  return (target.files ?? [target.file]).length === 1 ? historyPathOf(target.file) : null;
}
registerMenuItems('wt-file', [
  {
    id: 'file-history',
    order: 30,
    visible: (ctx) => wtPath(ctx.target) !== null,
    run: (ctx) => {
      const path = wtPath(ctx.target);
      if (path !== null) openFileHistory(path, { mode: 'changes' });
    },
  },
  {
    id: 'file-blame',
    order: 31,
    visible: (ctx) => wtPath(ctx.target) !== null && !ctx.target.file.submodule,
    run: (ctx) => {
      const path = wtPath(ctx.target);
      if (path !== null) openFileHistory(path, { mode: 'blame' });
    },
  },
]);

// - - Menu `commit-file`: a file listed under a commit; its history is read up to that commit - -
registerMenuItems('commit-file', [
  {
    id: 'file-history',
    order: 10,
    run: (ctx) => openFileHistory(ctx.target.file.path, { rev: ctx.target.oid, mode: 'changes' }),
  },
  {
    id: 'file-blame',
    order: 11,
    // A deleted file is gone in that commit; a binary file or a submodule has no lines.
    visible: (ctx) => !ctx.target.file.submodule && !ctx.target.file.binary && ctx.target.file.change !== 'deleted',
    run: (ctx) => openFileHistory(ctx.target.file.path, { rev: ctx.target.oid, mode: 'blame' }),
  },
]);

// - - Palette: the file the center view is about (the open diff, or the history already open) - -
function needsFile(ctx: ActionContext): string | null {
  if (ctx.repoId === null) return t('action.noRepo');
  const file = currentFile(ctx.status.files);
  if (file === null) return t('history.action.noFile');
  return file.path === null ? t('history.action.uncommitted') : null;
}

registerAction({
  id: 'file.history',
  label: () => t('history.action.show'),
  disabledReason: needsFile,
  run: (ctx) => {
    const file = currentFile(ctx.status.files);
    if (file?.path) openFileHistory(file.path, { rev: file.rev, mode: 'changes' });
  },
});
registerAction({
  id: 'file.blame',
  label: () => t('history.action.blame'),
  disabledReason: needsFile,
  run: (ctx) => {
    const file = currentFile(ctx.status.files);
    if (file?.path) openFileHistory(file.path, { rev: file.rev, mode: 'blame' });
  },
});
