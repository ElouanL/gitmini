// Background menu entries of the base: those that do not depend on any domain dialogue
// (checkout, copies, external opening, fetch/push/pull). The others (merge, rebase, cherry-pick, stash, rename, delete...)
// are added by their domains with `registerMenuItems`.
import { commands, type CheckoutTarget } from '../ipc/commands';
import { openDialog } from '../dialogs/registry';
import { fetchRemote } from '../actions/builtin';
import { checkoutTarget } from '../actions/checkout';
import { copyText } from '../clipboard';
import { reportError } from '../errors/report';
import { t } from '../../i18n/index';
import { registerMenuItems } from './registry';

async function checkout(_repoId: number | null, target: CheckoutTarget, _label?: string): Promise<void> {
  await checkoutTarget(target);
}

export function registerBuiltinMenus(): void {
  registerMenuItems('commit', [
    {
      id: 'checkout-detached',
      label: () => t('menu.commit.checkoutDetached'),
      order: 10,
      enabled: (ctx) => ctx.op.blockReason('write') === null,
      run: (ctx) => checkout(ctx.repoId, { kind: 'detached', oid: ctx.target.oid }, t('op.checkout')),
    },
    {
      id: 'create-branch',
      label: () => t('menu.commit.createBranch'),
      order: 20,
      enabled: (ctx) => ctx.op.blockReason('branch') === null,
      run: async (ctx) => {
        await openDialog('branch-create-dialog', { startPoint: ctx.target.oid });
      },
    },
    {
      id: 'copy-sha',
      label: (ctx) => t(ctx.target.oids.length > 1 ? 'menu.commit.copyShaMany' : 'menu.commit.copySha'),
      order: 90,
      run: (ctx) => void copyText(ctx.target.oids.join('\n')),
    },
    {
      id: 'copy-message',
      label: () => t('menu.commit.copyMessage'),
      order: 91,
      visible: (ctx) => ctx.target.oids.length <= 1,
      run: async (ctx) => {
        if (ctx.repoId === null) return;
        const d = await commands.commitDetails({ repoId: ctx.repoId, oid: ctx.target.oid });
        await copyText(d.message);
      },
    },
  ]);

  registerMenuItems('branch', [
    {
      id: 'checkout',
      label: () => t('menu.branch.checkout'),
      order: 10,
      visible: (ctx) => !ctx.target.branch.isHead,
      enabled: (ctx) => ctx.op.blockReason('write') === null,
      run: (ctx) => checkout(ctx.repoId, { kind: "local", name: ctx.target.branch.name }, t('op.checkout')),
    },
    {
      id: 'create-branch',
      label: (ctx) => t('menu.branch.createBranch', { name: ctx.target.branch.name }),
      order: 20,
      enabled: (ctx) => ctx.op.blockReason('branch') === null,
      run: async (ctx) => {
        await openDialog('branch-create-dialog', { startPoint: ctx.target.branch.name });
      },
    },
    {
      id: 'copy-name',
      label: () => t('menu.copyName'),
      order: 90,
      run: (ctx) => void copyText(ctx.target.branch.name),
    },
  ]);

  registerMenuItems('remote-branch', [
    {
      id: 'checkout',
      label: () => t('menu.remoteBranch.checkout'),
      order: 10,
      enabled: (ctx) => ctx.op.blockReason('write') === null,
      run: (ctx) => checkout(ctx.repoId, { kind: 'remote', ref: `${ctx.target.branch.remote}/${ctx.target.branch.name}` }, t('op.checkout')),
    },
    {
      id: 'create-branch',
      label: (ctx) => t('menu.branch.createBranch', { name: `${ctx.target.branch.remote}/${ctx.target.branch.name}` }),
      order: 20,
      enabled: (ctx) => ctx.op.blockReason('branch') === null,
      run: async (ctx) => {
        await openDialog('branch-create-dialog', { startPoint: `${ctx.target.branch.remote}/${ctx.target.branch.name}` });
      },
    },
    {
      id: 'copy-name',
      label: () => t('menu.copyName'),
      order: 90,
      run: (ctx) => void copyText(`${ctx.target.branch.remote}/${ctx.target.branch.name}`),
    },
  ]);

  registerMenuItems('remote', [
    {
      id: 'fetch',
      label: () => t('menu.remote.fetch'),
      order: 10,
      run: (ctx) => fetchRemote(ctx, ctx.target.remote.name),
    },
    {
      id: 'copy-url',
      label: () => t('menu.remote.copyUrl'),
      order: 90,
      run: (ctx) => void copyText(ctx.target.remote.fetchUrl),
    },
  ]);

  registerMenuItems('tag', [
    {
      id: 'checkout-detached',
      label: () => t('menu.commit.checkoutDetached'),
      order: 10,
      enabled: (ctx) => ctx.op.blockReason('write') === null,
      run: (ctx) => checkout(ctx.repoId, { kind: 'detached', oid: ctx.target.tag.targetOid }, t('op.checkout')),
    },
    { id: 'copy-name', label: () => t('menu.copyName'), order: 90, run: (ctx) => void copyText(ctx.target.tag.name) },
  ]);

  registerMenuItems('wt-file', [
    {
      id: 'open-external',
      label: () => t('menu.wtFile.openExternal'),
      order: 10,
      visible: (ctx) => !ctx.target.file.submodule && !ctx.target.file.nonUtf8,
      run: async (ctx) => {
        if (ctx.repoId === null) return;
        const repoId = ctx.repoId;
        const path = ctx.target.file.path;
        try {
          await commands.openExternal({ repoId, target: { kind: 'file', path, line: null } });
        } catch (e) {
          reportError(e, { command: 'open_external' });
        }
      },
    },
    {
      id: 'copy-path',
      label: () => t('menu.wtFile.copyPath'),
      order: 90,
      run: (ctx) => void copyText((ctx.target.files ?? [ctx.target.file]).map((f) => f.path).join('\n')),
    },
  ]);
}
