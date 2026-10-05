
import { captureStores } from '$lib/stores/context';
// Base actions (command palette identifiers). Domains can replace an action
// by recording the same `id` from their `register.ts`. Pull and push (`git.pull`, `git.pullFfOnly`, `git.pullRebase`, `git.push`)
// are not here: their complete logic (upstream, push-dialog, force-push, autostash...) lives in the remote domain.
import { commands } from '../ipc/commands';
import { featureFlags } from '../feature-flags';
import { pickFolder } from '../ipc/dialog';
import { openDialog, hasDialog } from '../dialogs/registry';
import { t } from '../../i18n/index';
import { repo } from '../stores/repo.svelte';

import { toast } from '../stores/toast.svelte';
import { focusZone } from './focus';
import { registerActions, type ActionContext, type ActionDef } from './registry';

const noRepo = (ctx: ActionContext): string | null => (ctx.repoId === null ? t('action.noRepo') : null);
const blocked = (kind: Parameters<ActionContext['op']['blockReason']>[0]) => (ctx: ActionContext): string | null =>
  noRepo(ctx) ?? ctx.op.blockReason(kind);

export function openRepoFromPicker(): Promise<void> {
  return pickFolder(t('welcome.pickTitle')).then(async (path) => {
    if (!path) return;
    await repo.openOrInit(path);
  });
}

async function doFetch(ctx: ActionContext, remote: string | null = null): Promise<void> {
  const owner = ctx.session;
  const { runWrite } = captureStores(owner);
  const repoId = ctx.repoId;
  if (repoId === null) return;
  const r = await runWrite(
    t('op.fetch'),
    ({ opId }) => commands.remoteFetch({ repoId, opId: opId!, remote, prune: true }),
    { long: true, command: 'remote_fetch' },
  );
  if (r.ok) toast.success(t('toast.fetchDone'));
}

async function stashSaveNow(ctx: ActionContext): Promise<void> {
  const owner = ctx.session;
  const { runWrite } = captureStores(owner);
  const repoId = ctx.repoId;
  if (repoId === null) return;
  const r = await runWrite(
    t('op.stash'),
    () => commands.stashSave({ repoId, includeUntracked: true, keepIndex: false }),
    { command: 'stash_save' },
  );
  if (!r.ok) return;
  ctx.refs.applyStashes(r.value.list);
  if (r.value.created === null) toast.info(t('toast.nothingToStash'));
}

async function stashPopTop(ctx: ActionContext): Promise<void> {
  const owner = ctx.session;
  const { runWrite } = captureStores(owner);
  const repoId = ctx.repoId;
  const top = ctx.refs.stashes[0];
  if (repoId === null || !top) return;
  const r = await runWrite(
    t('op.stashPop'),
    () => commands.stashPop({ repoId, oid: top.oid, index: top.index, restoreIndex: false }),
    { command: 'stash_pop' },
  );
  if (!r.ok) return;
  ctx.refs.applyStashes(r.value.list);
  if (r.value.conflicts.length > 0) toast.info(t('toast.stashConflict', { index: top.index }));
}

async function undoLast(ctx: ActionContext): Promise<void> {
  const owner = ctx.session;
  const { openDialog } = captureStores(owner);
  const entry = ctx.undo.entry;
  if (!entry || !ctx.undo.available) return;
  if (hasDialog('undo-confirm-dialog')) {
    await openDialog('undo-confirm-dialog', { entry, expectedHead: ctx.undo.status?.head ?? null });
    return;
  }
  await ctx.undo.perform(entry);
}

export const builtinActions: ActionDef[] = [
  {
    id: 'palette.open',
    label: () => t('action.palette'),
    palette: false,
    run: (ctx) => {
      ctx.ui.paletteOpen = !ctx.ui.paletteOpen;
    },
  },
  {
    id: 'repo.open',
    label: () => t('action.repoOpen'),
    disabledReason: () => repo.opening ? t('app.loading') : null,
    run: () => openRepoFromPicker(),
  },
  {
    id: 'repo.clone',
    label: () => t('action.repoClone'),
    run: async () => {
      await openDialog('clone-dialog');
    },
  },
  { id: 'git.fetch', label: () => t('action.fetch'), disabledReason: blocked('fetch'), run: (ctx) => doFetch(ctx) },
  {
    id: 'branch.create',
    label: () => t('action.branchCreate'),
    // Without checkout, `branch_create` is refused only if a writing is in flight: the dialogue decides the rest.
    disabledReason: blocked('branch'),
    run: async (ctx) => {
      await openDialog('branch-create-dialog', { startPoint: ctx.graph.singleCommitOid });
    },
  },
  {
    id: 'stash.save',
    label: () => t('action.stashSave'),
    disabledReason: (ctx) => blocked('write')(ctx) ?? (ctx.status.clean ? t('toolbar.stashNothing') : null),
    run: (ctx) => stashSaveNow(ctx),
  },
  {
    id: 'stash.dialog',
    label: () => t('action.stashDialog'),
    palette: false,
    disabledReason: (ctx) => blocked('write')(ctx) ?? (ctx.status.clean ? t('toolbar.stashNothing') : null),
    run: async () => {
      await openDialog('stash-save-dialog', {});
    },
  },
  {
    id: 'stash.pop',
    label: () => t('action.stashPop'),
    disabledReason: (ctx) => blocked('write')(ctx) ?? (ctx.refs.stashes.length === 0 ? t('toolbar.noStash') : null),
    run: (ctx) => stashPopTop(ctx),
  },
  {
    id: 'undo.last',
    label: () => t('action.undo'),
    disabledReason: (ctx) => noRepo(ctx) ?? (ctx.undo.available ? ctx.op.blockReason('control') : ctx.undo.tooltip),
    run: (ctx) => undoLast(ctx),
  },
  {
    id: 'view.reflog',
    label: () => t('action.reflog'),
    disabledReason: noRepo,
    run: (ctx) => ctx.ui.toggleDrawer('reflog-panel'),
  },
  {
    id: 'github.login',
    label: () => t('action.githubLogin'),
    enabled: (ctx) => featureFlags.githubLogin && !ctx.github.loggedIn,
    run: async () => {
      await openDialog('github-login-dialog');
    },
  },
  {
    id: 'github.logout',
    label: () => t('action.githubLogout'),
    enabled: (ctx) => featureFlags.githubLogin && ctx.github.loggedIn,
    run: (ctx) => ctx.github.logout(),
  },
  {
    id: 'settings.open',
    label: () => t('action.settings'),
    run: async () => {
      await openDialog('settings-dialog');
    },
  },
  {
    id: 'theme.toggle',
    label: () => t('action.themeToggle'),
    run: async (ctx) => {
      await ctx.app.toggleTheme();
    },
  },
  {
    id: 'graph.search',
    label: () => t('action.search'),
    disabledReason: noRepo,
    run: (ctx) => {
      ctx.ui.closeCenter();
      ctx.graph.searchOpen = true;
    },
  },
  // Service actions (not in the palette).
  { id: 'focus.sidebar', label: () => t('action.focusSidebar'), palette: false, disabledReason: noRepo, run: () => void focusZone('sidebar') },
  { id: 'focus.graph', label: () => t('action.focusGraph'), palette: false, disabledReason: noRepo, run: () => void focusZone('graph') },
  { id: 'focus.right', label: () => t('action.focusRight'), palette: false, disabledReason: noRepo, run: () => void focusZone('right') },
];

export function registerBuiltinActions(): () => void {
  return registerActions(builtinActions);
}

/** Fetch of a remote (or all): reused by the menu entries of the remote domain. */
export { doFetch as fetchRemote };
