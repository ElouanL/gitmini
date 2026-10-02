// Domain "stash" (08): dialogs, retail panel, menu entries (`stash`, `wip`, `wt-file`), actions.
// Replaces `stash.save` and `stash.pop` of the base (same id) to go through `stash-ops`: announced conflicts, `INDEX_CONFLICT`, undo of the drop.
// Components and heavy logic (`stash-ops`) are loaded on demand (initial JS budget, `pnpm size`): here only registers.
import { trackActivity } from '$lib/activity';
import { registerAction } from '$lib/actions/registry';
import { openDialog, registerDialog } from '$lib/dialogs/registry';
import { registerMenuItems } from '$lib/menus/registry';
import { registerRightPanel } from '$lib/panels/registry';
import { graph } from '$lib/stores/graph.svelte';
import { op } from '$lib/stores/op.svelte';
import { status } from '$lib/stores/status.svelte';
import { t } from '$i18n/index';
import { stashablePaths } from './stash-text';

registerDialog('stash-save-dialog', () => import('./StashSaveDialog.svelte'));
registerDialog('stash-branch-dialog', () => import('./StashBranchDialog.svelte'));
registerRightPanel('stash-detail-panel', () => import('./StashDetailPanel.svelte'));

// `trackActivity` : `window.__gitmini.idle` also awaits loading of the action chunk (if not it resolves before the start of the command).
const ops = () => trackActivity('chunk:stash-ops', import('./stash-ops'));

// ── Actions

const noRepo = (repoId: number | null): string | null => (repoId === null ? t('action.noRepo') : null);

registerAction({
  id: 'stash.save',
  label: () => t('action.stashSave'),
  disabledReason: (ctx) => noRepo(ctx.repoId) ?? ctx.op.blockReason('write') ?? (ctx.status.clean ? t('toolbar.stashNothing') : null),
  // `toolbar-stash-btn`: immediate stash, not followed, without message (08 §Sidebar and toolbar).
  run: async () => {
    await (await ops()).saveStash({ includeUntracked: true, keepIndex: false });
  },
});

registerAction({
  id: 'stash.pop',
  label: () => t('action.stashPop'),
  disabledReason: (ctx) => noRepo(ctx.repoId) ?? ctx.op.blockReason('write') ?? (ctx.refs.stashes.length === 0 ? t('toolbar.noStash') : null),
  run: async (ctx) => {
    const top = ctx.refs.stashes[0];
    if (top) await (await ops()).applyStash('pop', top, false, ctx.session);
  },
});

registerAction({
  id: 'stash.save-paths',
  label: () => t('menu.item.stash-paths'),
  palette: false,
  disabledReason: (ctx) => noRepo(ctx.repoId) ?? ctx.op.blockReason('write'),
  run: async (ctx) => {
    const target = ctx.target;
    if (target?.menu !== 'wt-file') return;
    const paths = stashablePaths(target.files ?? [target.file]);
    if (paths.length === 0) return;
    await openDialog('stash-save-dialog', { paths });
  },
});

// ── Menus contextuels

const writeEnabled = (): boolean => op.blockReason('write') === null;

registerMenuItems('stash', [
  {
    id: 'stash-apply',
    order: 10,
    label: () => t('menu.item.stash-apply'),
    enabled: writeEnabled,
    run: async (ctx) => void (await (await ops()).applyStash('apply', ctx.target.stash, false, ctx.session)),
  },
  {
    id: 'stash-pop',
    order: 20,
    label: () => t('menu.item.stash-pop'),
    enabled: writeEnabled,
    run: async (ctx) => void (await (await ops()).applyStash('pop', ctx.target.stash, false, ctx.session)),
  },
  {
    id: 'stash-branch',
    order: 30,
    label: () => t('menu.item.stash-branch'),
    enabled: writeEnabled,
    run: async (ctx) => void (await openDialog('stash-branch-dialog', { stash: ctx.target.stash })),
  },
  {
    id: 'stash-show',
    order: 40,
    label: () => t('menu.item.stash-show'),
    run: (ctx) => graph.selectStash(ctx.target.stash.oid, ctx.target.stash.index),
  },
  {
    // Without confirmation: the undo covers the error. Permits during a state-of-the-art operation.
    id: 'stash-drop',
    danger: true,
    label: () => t('menu.item.stash-drop'),
    enabled: () => op.blockReason('index') === null,
    run: async (ctx) => void (await (await ops()).dropStash(ctx.target.stash, ctx.session)),
  },
]);

registerMenuItems('wip', [
  {
    id: 'stash-save',
    order: 50,
    label: () => t('menu.item.stash-save'),
    enabled: (ctx) => ctx.op.blockReason('write') === null && !status.clean && ctx.repoId !== null,
    run: async () => void (await openDialog('stash-save-dialog', {})),
  },
]);

registerMenuItems('wt-file', [
  {
    id: 'stash-paths',
    order: 50,
    action: 'stash.save-paths',
    label: () => t('menu.item.stash-paths'),
    // Submodule and path no UTF-8: read only, only `copy-path` is proposed (03 §Contextual Menus).
    visible: (ctx) => stashablePaths([ctx.target.file]).length > 0,
  },
]);
