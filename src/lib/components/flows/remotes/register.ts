// Remote domain (10): push, pull, remote management, clone, PR opening.
// Replaces the actions of the `git.pull`, `git.pullFfOnly`, `git.pullRebase`, `git.push` (same id) and the `push` / `pull` entries of the
// `branch` menu (which called the functions of the base). `git.fetch` and the `remote > fetch` menu of the base remain unchanged.
// Lazy loading dialogs, logical (`sync`, `remote-ops`) imported on execution (initial JS budget, `pnpm size`).
import { trackActivity } from '$lib/activity';
import { registerAction, type ActionContext } from '$lib/actions/registry';
import { registerDialog } from '$lib/dialogs/registry';
import { registerMenuItems } from '$lib/menus/registry';
import { t } from '$i18n/index';
import { registerRemoteErrorHandlers } from './errors';
import { githubRemoteFor } from './remote-logic';

registerDialog('push-dialog', () => import('./PushDialog.svelte'));
registerDialog('push-rejected-dialog', () => import('./PushRejectedDialog.svelte'));
registerDialog('pull-diverged-dialog', () => import('./PullDivergedDialog.svelte'));
registerDialog('pull-autostash-dialog', () => import('./PullAutostashDialog.svelte'));
registerDialog('remote-add-dialog', () => import('./RemoteAddDialog.svelte'));
registerDialog('clone-dialog', () => import('./CloneDialog.svelte'));

// `trackActivity` : `window.__gitmini.idle` also awaits loading of the action chunk (if not it resolves before the start of the command).
const sync = () => trackActivity('chunk:remotes-sync', import('./sync'));
const remoteOps = () => trackActivity('chunk:remotes-ops', import('./remote-ops'));

// ── Actions

const noRepo = (ctx: ActionContext): string | null => (ctx.repoId === null ? t('action.noRepo') : null);
/** Pull and push have no sense in detached HEAD (03 "Toolbar"). */
const syncReason = (ctx: ActionContext): string | null =>
  noRepo(ctx) ?? ctx.op.blockReason('write') ?? (ctx.repo.head?.detached ? t('toolbar.detachedNoSync') : null);

registerAction({ id: 'git.pull', label: () => t('action.pull'), disabledReason: syncReason, run: async (ctx) => void (await (await sync()).pullCurrent(ctx)) });
registerAction({ id: 'git.pullFfOnly', label: () => t('action.pullFfOnly'), disabledReason: syncReason, run: async (ctx) => void (await (await sync()).pullCurrent(ctx, 'ff-only')) });
registerAction({ id: 'git.pullRebase', label: () => t('action.pullRebase'), disabledReason: syncReason, run: async (ctx) => void (await (await sync()).pullCurrent(ctx, 'rebase')) });
registerAction({ id: 'git.push', label: () => t('action.push'), disabledReason: syncReason, run: async (ctx) => (await sync()).pushBranch(ctx) });

// ── Erreurs

registerRemoteErrorHandlers();

// ── Menus contextuels

registerMenuItems('branch', [
  {
    id: 'push',
    order: 60,
    label: () => t('menu.branch.push'),
    run: async (ctx) => (await sync()).pushBranch(ctx, ctx.target.branch.name),
  },
  {
    id: 'pull',
    order: 61,
    label: () => t('menu.branch.pull'),
    visible: (ctx) => ctx.target.branch.isHead && ctx.target.branch.upstream !== null,
    run: async (ctx) => void (await (await sync()).pullCurrent(ctx)),
  },
  {
    id: 'open-pr',
    order: 70,
    label: () => t('remotes.menu.openPr'),
    // Upstream on a GitHub remote (otherwise `origin`, like `github_open_pr`).
    visible: (ctx) => githubRemoteFor(ctx.target.branch, ctx.refs.remotes) !== null,
    run: async (ctx) => void (await (await remoteOps()).openPullRequest(ctx.target.branch.name, ctx.session)),
  },
]);

registerMenuItems('remote-branch', [
  {
    id: 'open-pr',
    order: 70,
    label: () => t('remotes.menu.openPr'),
    visible: (ctx) => ctx.refs.remotes.some((r) => r.name === ctx.target.branch.remote && r.isGithub),
    run: async (ctx) => void (await (await remoteOps()).openPullRequest(ctx.target.branch.name, ctx.session)),
  },
]);

registerMenuItems('remote', [
  {
    // Delete the delete: `confirm-dialog[data-action=remote-remove]` and then `remote_remove`.
    id: 'delete',
    danger: true,
    label: () => t('menu.item.delete'),
    enabled: (ctx) => ctx.op.blockReason('index') === null,
    run: async (ctx) => void (await (await remoteOps()).removeRemote(ctx.target.remote, ctx.session)),
  },
]);
