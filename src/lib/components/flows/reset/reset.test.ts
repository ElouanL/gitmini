// "reset" flow: commit menu entry, `reset-dialog` (mode choice), `branch_reset`, undo toast and errors.
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { whenIdle } from '$lib/activity';
import { actionContext, actionDisabledReason, getAction, runAction } from '$lib/actions/registry';
import DialogHost from '$lib/components/dialogs-base/DialogHost.svelte';
import '$lib/components/dialogs-base/register';
import { preloadDialog } from '$lib/dialogs/registry';
import { resolveMenu } from '$lib/menus/registry';
import { op } from '$lib/stores/op.svelte';
import { toast } from '$lib/stores/toast.svelte';
import { makeConflictState, makeRefs, makeStatus, makeUndo, oid as fixtureOid } from '$lib/test/fixtures';
import { resetAll } from '$lib/test/reset';
import type { UndoKind } from '$lib/ipc/types';
import { openTestRepo } from '../test-support';
import '$lib/register-core';
import './register';
import { registerResetErrorHandlers } from './errors';
import { trackedChanges } from './run';

const tid = (id: string) => screen.getByTestId(id);
const maybe = (id: string) => screen.queryByTestId(id);
const HEAD_OK = { head: { branch: 'main', oid: fixtureOid(55), detached: false, unborn: false } };
const at55 = { menu: 'commit' as const, oid: fixtureOid(55), oids: [fixtureOid(55)] };

beforeAll(async () => {
  await preloadDialog('reset-dialog');
}, 30_000);

beforeEach(() => {
  resetAll({ keepRegistrations: true });
  registerResetErrorHandlers();
});

function undoOf(kind: UndoKind) {
  const u = makeUndo(true);
  return { ...u, entry: { ...u.entry!, kind } };
}

async function openWithDialog(handlers: Record<string, () => unknown> = {}) {
  const fake = await openTestRepo({ branch_reset: () => HEAD_OK, ...handlers });
  render(DialogHost);
  return fake;
}

describe('commit menu entry', () => {
  it('names the current branch; hidden for several commits or a detached HEAD; disabled during an operation', async () => {
    await openTestRepo();
    const item = resolveMenu(at55).find((i) => i.id === 'reset');
    expect(item?.label).toBe('Reset main to here...');
    const many = resolveMenu({ menu: 'commit', oid: fixtureOid(55), oids: [fixtureOid(55), fixtureOid(54)] });
    expect(many.map((i) => i.id)).not.toContain('reset');
    op.setState(makeConflictState());
    expect(resolveMenu(at55).find((i) => i.id === 'reset')!.disabled).toBe(true);
  });

  it('detached HEAD: no entry, action disabled with a reason', async () => {
    const head = { branch: null, oid: fixtureOid(60), detached: true, unborn: false };
    await openTestRepo({ refs_list: () => ({ ...makeRefs(), head: { kind: 'detached', oid: fixtureOid(60) } }) }, { head });
    expect(resolveMenu(at55).map((i) => i.id)).not.toContain('reset');
    expect(actionDisabledReason(getAction('reset.to')!, actionContext(at55))).toBe('Reset requires a branch: HEAD is detached.');
  });
});

describe('reset-dialog', () => {
  it('mixed by default; confirm sends the mode and the HEAD seen; undo toast', async () => {
    const fake = await openWithDialog({ undo_peek: () => undoOf('reset-mixed') });
    const running = runAction('reset.to', at55);
    const dlg = await screen.findByTestId('reset-dialog');
    expect(dlg).toHaveAttribute('data-mode', 'mixed');
    expect(tid('reset-mode-mixed')).toBeChecked();
    expect(maybe('reset-hard-warning')).toBeNull();
    await userEvent.click(tid('reset-confirm-btn'));
    await running;
    await whenIdle();
    expect(fake.callsOf('branch_reset')[0]!.args).toEqual({ repoId: 1, oid: fixtureOid(55), mode: 'mixed', expectedHead: fixtureOid(60) });
    await waitFor(() => expect(toast.items.find((t) => t.kind === 'undo')?.message).toBe(`main reset to ${fixtureOid(55).slice(0, 7)}`));
  });

  it('hard: destructive dialog counting tracked changes; no undo toast', async () => {
    const fake = await openWithDialog({ status_get: () => makeStatus() });
    const running = runAction('reset.to', at55);
    await screen.findByTestId('reset-dialog');
    await userEvent.click(tid('reset-mode-hard'));
    expect(tid('reset-dialog')).toHaveAttribute('data-mode', 'hard');
    // README.md (staged) and src/App.svelte (unstaged); notes.txt is untracked
    expect(tid('reset-hard-warning')).toHaveTextContent('Local changes to 2 tracked files will be lost.');
    await userEvent.click(tid('reset-confirm-btn'));
    await running;
    await whenIdle();
    expect(fake.callsOf('branch_reset')[0]!.args).toMatchObject({ mode: 'hard' });
    expect(toast.items.some((t) => t.kind === 'undo')).toBe(false);
    expect(toast.items.at(-1)?.message).toBe(`main reset to ${fixtureOid(55).slice(0, 7)}`);
  });

  it('cancel calls nothing', async () => {
    const fake = await openWithDialog();
    const running = runAction('reset.to', at55);
    await screen.findByTestId('reset-dialog');
    await userEvent.click(tid('reset-cancel-btn'));
    await running;
    expect(fake.callsOf('branch_reset')).toHaveLength(0);
  });
});

describe('errors', () => {
  it('STALE head: explicit message', async () => {
    await openWithDialog({
      branch_reset: () => {
        throw { code: 'STALE', message: 'x', details: { what: 'head' } };
      },
    });
    const running = runAction('reset.to', at55);
    await screen.findByTestId('reset-dialog');
    await userEvent.click(tid('reset-confirm-btn'));
    await running;
    await whenIdle();
    expect(toast.items.at(-1)?.message).toBe('The branch moved since the dialog opened. Try again.');
  });
});

describe('trackedChanges', () => {
  it('counts staged or modified tracked files, not untracked ones', () => {
    expect(trackedChanges(makeStatus().files)).toBe(2);
    expect(trackedChanges([])).toBe(0);
  });
});
