import { captureStores } from '$lib/stores/context';
// Domain entry point working tree / diff / commit (05). Imported automatically on startup (`register-domains.ts`).
// Record: right panel `wt-panel`, central view `diff` (`diff-viewer`), `identity-dialog` dialog, menu entries
// `wt-file` and `wip`, shares, merge message provider, hook failure manager (`commit-hook-output`).
import { registerAction, type ActionContext } from '$lib/actions/registry';
import type { FileStatus } from '$lib/ipc/types';
import { registerMergeMessageProvider } from '$lib/banner/merge-message';
import { registerDialog } from '$lib/dialogs/registry';
import { registerErrorHandler } from '$lib/errors';
import { registerMenuItems, type MenuItemDef } from '$lib/menus/registry';
import { registerCenterView, registerRightPanel } from '$lib/panels/registry';
import { graph } from '$lib/stores/graph.svelte';
import { repo } from '$lib/stores/repo.svelte';
import { status } from '$lib/stores/status.svelte';
import { t, tp } from '$i18n/index';
import type { ConflictSide } from '$lib/ipc/commands';
import { normalizeDiffContext, stepDiffContext } from '$lib/ipc/settings-types';
import { resolveSideText } from '../diff/conflict';
import { commitForm } from '../commit-form/form-state.svelte';
import { hookOutputFor } from '../commit-form/hook-output';
import { startCommitFormWiring } from '../commit-form/wiring.svelte';
import { discardAll, resolveWithSide, stagePaths, unstagePaths } from './actions';
import { discardable, offersSides, resolvable, stageable, unstageable } from './list-model';

// Lazy loaders (initial JS budget, ) : each component is a separate chunk, downloaded at the first opening.
// must only import registers, light modules and TYPES, never a component or a diff computing module.
registerRightPanel('wt-panel', () => import('./WtPanel.svelte'));
registerCenterView('diff', () => import('../diff/DiffViewer.svelte'));
registerDialog('identity-dialog', () => import('../identity/IdentityDialog.svelte'));

// - - Contextual menus (: closed list) - -
// Menu `wt-file`: `open-external` and `copy-path` come from the base, `stash-paths` from the domain stash (action `stash.save-paths`).
registerMenuItems('wip', [
  {
    id: 'discard-all',
    label: () => t('wt.menu.discardAll'),
    danger: true,
    order: 90,
    visible: () => discardable(status.files).length > 0,
    run: async () => {
      await discardAll();
    },
  },
]);

// "Take ours / theirs" on conflicted files (menu `wt-file` of the conflict list): one click resolves every selected file.
const filesOf = (target: { file: FileStatus; files?: FileStatus[] }): FileStatus[] => target.files ?? [target.file];

function resolveItem(side: ConflictSide): MenuItemDef<'wt-file'> {
  return {
    id: side === 'ours' ? 'resolve-ours' : 'resolve-theirs',
    order: side === 'ours' ? 20 : 21,
    label: (ctx) => {
      const n = filesOf(ctx.target).length;
      const text = resolveSideText(side, ctx.op.state);
      return n > 1 ? `${text} (${tp('wt.files', n)})` : text;
    },
    visible: (ctx) => offersSides(filesOf(ctx.target)),
    enabled: (ctx) => ctx.op.blockReason('index') === null,
    run: async (ctx) => {
      await resolveWithSide(resolvable(filesOf(ctx.target)).map((f) => f.path), side, ctx.session);
    },
  };
}
registerMenuItems('wt-file', [resolveItem('ours'), resolveItem('theirs')]);

// - - More / less context in the open diff (DIFF-05): steps `diff.contextLines` through its choices, from the palette - -
function contextStep(delta: 1 | -1) {
  const next = (ctx: ActionContext) => stepDiffContext(normalizeDiffContext(ctx.app.get('diff.contextLines')), delta);
  return {
    id: delta === 1 ? 'diff.context-more' : 'diff.context-less',
    label: () => t(delta === 1 ? 'diff.action.contextMore' : 'diff.action.contextLess'),
    disabledReason: (ctx: ActionContext) =>
      ctx.ui.centerView.id !== 'diff' ? t('diff.action.noDiff') : next(ctx) === null ? t(delta === 1 ? 'diff.action.contextMax' : 'diff.action.contextMin') : null,
    run: (ctx: ActionContext) => {
      const lines = next(ctx);
      if (lines !== null) void ctx.app.set('diff.contextLines', lines);
    },
  };
}
registerAction(contextStep(1));
registerAction(contextStep(-1));

// - - Actions (excluding palette: the palette lists only the toolbar commands, 03) - -
registerAction({
  id: 'wt.stage-all',
  label: () => t('wt.action.stageAll'),
  palette: false,
  enabled: () => stageable(status.files).length > 0,
  disabledReason: (ctx) => ctx.op.blockReason('index'),
  run: async () => {
    await stagePaths('all');
  },
});
registerAction({
  id: 'wt.unstage-all',
  label: () => t('wt.action.unstageAll'),
  palette: false,
  enabled: () => unstageable(status.files).length > 0,
  disabledReason: (ctx) => ctx.op.blockReason('index'),
  run: async () => {
    await unstagePaths('all');
  },
});
registerAction({
  id: 'wt.discard-all',
  label: () => t('wt.menu.discardAll'),
  palette: false,
  enabled: () => discardable(status.files).length > 0,
  disabledReason: (ctx) => ctx.op.blockReason('index'),
  run: async () => {
    await discardAll();
  },
});
/**
 * "Amend the last commit" (palette `Mod+K`, 05 "Amend): select the line WIP and check the box; the warning
 * "Already pushed" follows the box. Only way to amend a clean repository (the WIP line of the graph only exists if there are files, 04).
 */
registerAction({
  id: 'commit.amend',
  label: () => t('wt.action.amend'),
  enabled: (ctx) => ctx.op.state === null && !!repo.head && !repo.head.unborn,
  run: async () => {
    graph.selectWip();
    await commitForm.setAmend(true);
  },
});

// "Hook who refuses: stderr in `commit-hook-output`, message kept, no toast (05 "Commit", )"
/** Saves domain error handlers (exported for tests, including `resetAll` emptys managers). */
export function installWtErrorHandlers(): void {
  registerErrorHandler('GIT_FAILED', (err, ctx) => {
    const out = hookOutputFor(err, ctx.command);
    if (!out) return false;
    commitForm.showHook(out.stderr, out.command);
    // End of merge launched from the banner: the form (and its hook output) is in `wt-panel`.
    if (out.command === 'merge_continue' && graph.selection.kind !== 'wip') graph.selectWip();
    return true;
  });
}
installWtErrorHandlers();

// Message from `merge_continue` launched by `op-banner-continue-btn`: that of the form (`data-mode=merge`).
registerMergeMessageProvider((owner) => {
  const { op, commitForm } = captureStores(owner);
  return op.state?.kind === 'merge' ? commitForm.mergeMessage() : null;
});
startCommitFormWiring();
