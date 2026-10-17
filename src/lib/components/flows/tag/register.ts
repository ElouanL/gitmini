// Domain "tags": `tag-create-dialog`, `tag-push-dialog` and `tag-remote-delete-dialog`, the `create-tag` entry of the commit
// menu, the `push`, `delete` and `delete-remote` entries of the tag menu (actions `tag.push`, `tag.delete`,
// `tag.deleteRemote`), and the `tag.create` action (palette, sidebar `+`).
// Deleting a tag locally asks nothing: the toast and `Mod+Z` undo it. Deleting it on a remote always asks (and is not
// undoable). The logic (`run`) loads on first use (initial JS budget).
import { t } from '$i18n/index';
import { trackActivity } from '$lib/activity';
import { registerAction, type ActionContext } from '$lib/actions/registry';
import { registerDialog } from '$lib/dialogs/registry';
import { registerMenuItems } from '$lib/menus/registry';

registerDialog('tag-create-dialog', () => import('./TagCreateDialog.svelte'));
registerDialog('tag-push-dialog', () => import('./TagPushDialog.svelte'));
registerDialog('tag-remote-delete-dialog', () => import('./TagRemoteDeleteDialog.svelte'));

// `trackActivity`: `window.__gitmini.idle` also awaits the loading of the chunk (else it resolves before the command starts).
const ops = () => trackActivity('chunk:tags-run', import('./run'));

const noRepo = (ctx: ActionContext): string | null => (ctx.repoId === null ? t('action.noRepo') : null);

/** Creating a tag needs a commit and no write in flight; it is allowed during a rebase or merge (it touches no state). */
const createReason = (ctx: ActionContext): string | null =>
  noRepo(ctx) ?? (ctx.repo.head?.unborn ? t('tags.create.noCommit') : ctx.op.blockReason('branch'));

registerAction({
  id: 'tag.create',
  label: () => t('tags.action.create'),
  disabledReason: createReason,
  // Tags the selected commit if exactly one is selected, else HEAD (as `branch.create` does).
  run: async (ctx) => {
    await (await ops()).openCreateTag(ctx.graph.singleCommitOid, ctx.session);
  },
});

registerMenuItems('commit', [
  {
    id: 'create-tag',
    label: () => t('tags.menu.create'),
    order: 25,
    visible: (ctx) => ctx.target.oids.length <= 1,
    enabled: (ctx) => createReason(ctx) === null,
    run: async (ctx) => {
      await (await ops()).openCreateTag(ctx.target.oid, ctx.session);
    },
  },
]);

/** Talking to a remote needs one, and no write in flight (like fetch, it is allowed during an operation). */
const remoteReason = (ctx: ActionContext): string | null =>
  noRepo(ctx) ?? (ctx.refs.remotes.length === 0 ? t('toast.noRemote') : ctx.op.blockReason('fetch'));

registerAction({
  id: 'tag.push',
  label: () => t('tags.action.push'),
  palette: false,
  disabledReason: remoteReason,
  run: async (ctx) => {
    if (ctx.target?.menu === 'tag') await (await ops()).pushTag(ctx.target.tag.name, ctx.session);
  },
});

registerAction({
  id: 'tag.deleteRemote',
  label: () => t('tags.action.deleteRemote'),
  palette: false,
  disabledReason: remoteReason,
  run: async (ctx) => {
    if (ctx.target?.menu === 'tag') await (await ops()).deleteRemoteTag(ctx.target.tag.name, ctx.session);
  },
});

registerAction({
  id: 'tag.delete',
  label: () => t('tags.menu.delete'),
  palette: false,
  disabledReason: (ctx) => noRepo(ctx) ?? ctx.op.blockReason('branch'),
  run: async (ctx) => {
    if (ctx.target?.menu === 'tag') await (await ops()).deleteTag(ctx.target.tag.name, ctx.session);
  },
});

registerMenuItems('tag', [
  {
    id: 'push',
    order: 20,
    action: 'tag.push',
    label: (ctx) => {
      const remotes = ctx.refs.remotes;
      return remotes.length === 1 ? t('tags.menu.push', { remote: remotes[0]!.name }) : t('tags.menu.pushChoose');
    },
    // Nothing to push to without a remote. Like fetch, allowed during an operation, refused while a write is in flight.
    visible: (ctx) => ctx.refs.remotes.length > 0,
  },
  { id: 'delete', danger: true, action: 'tag.delete', label: () => t('tags.menu.delete') },
  {
    id: 'delete-remote',
    danger: true,
    order: 110,
    action: 'tag.deleteRemote',
    label: (ctx) => {
      const remotes = ctx.refs.remotes;
      return remotes.length === 1 ? t('tags.menu.deleteRemote', { remote: remotes[0]!.name }) : t('tags.menu.deleteRemoteChoose');
    },
    visible: (ctx) => ctx.refs.remotes.length > 0,
  },
]);
