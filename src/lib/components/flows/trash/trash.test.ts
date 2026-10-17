// "discarded files" flow: the drawer next to the reflog (list, restore, errors, refresh), its tabs, the palette action and
// the toast that follows a discard.
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { whenIdle } from '$lib/activity';
import { actionContext, actionDisabledReason, getAction, runAction } from '$lib/actions/registry';
import CenterArea from '$lib/components/layout/CenterArea.svelte';
import DialogHost from '$lib/components/dialogs-base/DialogHost.svelte';
import '$lib/components/dialogs-base/register';
import ToastContainer from '$lib/components/toast/ToastContainer.svelte';
import { discardFiles } from '$lib/components/wt/actions';
import type { AppError, DiscardedFile, FileStatus } from '$lib/ipc/types';
import type { DiscardRestoreResult } from '$lib/ipc/commands';
import { op } from '$lib/stores/op.svelte';
import { toast } from '$lib/stores/toast.svelte';
import { ui } from '$lib/stores/ui.svelte';
import { makeConflictState, makeStatus } from '$lib/test/fixtures';
import { resetAll } from '$lib/test/reset';
import { openTestRepo } from '../test-support';
import '$lib/register-core';
import '../undo/register';
import './register';
import DiscardTrashPanel from './DiscardTrashPanel.svelte';
import ReflogPanel from '../undo/ReflogPanel.svelte';

const tid = (id: string) => screen.getByTestId(id);
const maybe = (id: string) => screen.queryByTestId(id);
const now = Math.floor(Date.now() / 1000);

const entry = (id: string, path: string, over: Partial<DiscardedFile> = {}): DiscardedFile => ({
  id, path, oid: id.padEnd(40, 'a'), kind: 'file', size: 2048, time: now - 90, source: 'discard', ...over,
});
const ENTRIES: DiscardedFile[] = [
  entry('b2', 'src/lib/parser.ts', { time: now - 120 }),
  entry('a1', 'notes.txt', { size: 12, time: now - 3600, source: 'discard-hunk' }),
  entry('c3', 'build.sh', { kind: 'executable', size: 300, time: now - 86_400 * 2, source: 'resolve' }),
];
const file = (path: string): FileStatus => ({ path, oldPath: null, staged: null, unstaged: 'modified', conflict: null, oldMode: null, newMode: null, submodule: null, nonUtf8: null });
const result = (restored: string[], replaced: string[] = []): DiscardRestoreResult => ({ restored, replaced, status: makeStatus({ files: restored.map(file) }) });

beforeAll(async () => {
  // Load the drawer chunks once so that no test waits for a transform.
  await Promise.all([import('./DiscardTrashPanel.svelte'), import('../undo/ReflogPanel.svelte')]);
}, 30_000);

beforeEach(() => resetAll({ keepRegistrations: true }));

async function openPanel(handlers: Record<string, () => unknown> = {}) {
  const fake = await openTestRepo({ discard_list: () => ENTRIES, reflog_list: () => [], ...handlers });
  render(ToastContainer);
  render(DiscardTrashPanel, { props: { close: () => ui.closeDrawer() } });
  await whenIdle();
  return fake;
}

describe('discard-trash-panel', () => {
  it('lists what was discarded as the backend returns it: name, folder, source, size and age', async () => {
    const fake = await openPanel();
    expect(fake.callsOf('discard_list')[0]!.args).toEqual({ repoId: 1 });
    const rows = screen.getAllByTestId('trash-item');
    expect(rows.map((r) => r.getAttribute('data-path'))).toEqual(['src/lib/parser.ts', 'notes.txt', 'build.sh']);
    expect(rows.map((r) => r.getAttribute('data-source'))).toEqual(['discard', 'discard-hunk', 'resolve']);
    expect(within(rows[0]!).getByTestId('trash-item-name')).toHaveTextContent('parser.ts');
    expect(rows[0]).toHaveTextContent('src/lib');
    expect(within(rows[0]!).getByTestId('trash-item-meta')).toHaveTextContent('Discarded · 2.0 KiB · 2 minutes ago');
    expect(within(rows[1]!).getByTestId('trash-item-meta')).toHaveTextContent('Changes discarded · 12 B · 1 hour ago');
    expect(within(rows[2]!).getByTestId('trash-item-meta')).toHaveTextContent('Replaced while resolving · executable · 300 B · 2 days ago');
    expect(tid('trash-close-btn')).toHaveAccessibleName('Close discarded files');
    expect(tid('discard-trash-panel')).toHaveTextContent('Git may clean them up after about two weeks');
  });

  it('empty and failing states are messages, never a toast', async () => {
    await openPanel({ discard_list: () => [] });
    expect(tid('trash-empty')).toHaveTextContent('Nothing discarded yet.');
    expect(maybe('toast')).toBeNull();
  });

  it('a list that cannot be read says so quietly', async () => {
    const fake = await openTestRepo({ reflog_list: () => [] });
    fake.reject('discard_list', { code: 'GIT_FAILED', message: 'boom', details: {} } satisfies AppError);
    render(ToastContainer);
    render(DiscardTrashPanel, { props: { close: () => undefined } });
    await whenIdle();
    expect(tid('trash-error')).toHaveTextContent('Could not read the discarded files.');
    expect(maybe('toast')).toBeNull();
  });

  it('Restore sends the id, applies the returned status, says so and reloads the list', async () => {
    const fake = await openPanel({ discard_restore: () => result(['notes.txt']) });
    const row = screen.getAllByTestId('trash-item')[1]!;
    const button = within(row).getByTestId('trash-item-restore-btn');
    expect(button).toHaveAccessibleName('Restore notes.txt');
    await userEvent.click(button);
    await whenIdle();
    expect(fake.callsOf('discard_restore')[0]!.args).toEqual({ repoId: 1, ids: ['a1'] });
    expect(toast.items.at(-1)).toMatchObject({ kind: 'success', message: 'Restored notes.txt.' });
    expect(fake.callsOf('discard_list')).toHaveLength(2);
    const { status } = await import('$lib/stores/status.svelte');
    expect(status.files.map((f) => f.path)).toEqual(['notes.txt']);
  });

  it('tells when a restore overwrote a different version that is now in the list', async () => {
    await openPanel({ discard_restore: () => result(['notes.txt'], ['notes.txt']) });
    await userEvent.click(within(screen.getAllByTestId('trash-item')[1]!).getByTestId('trash-item-restore-btn'));
    await whenIdle();
    expect(toast.items.at(-1)?.message).toBe('Restored notes.txt. The version it replaced is in the list.');
  });

  it('content cleaned up by Git: explains it and reloads the list instead of showing a raw error', async () => {
    const fake = await openPanel();
    fake.reject('discard_restore', { code: 'NOT_FOUND', message: 'gone', details: { what: 'object', path: 'src/lib/parser.ts', id: 'b2' } } satisfies AppError);
    await userEvent.click(within(screen.getAllByTestId('trash-item')[0]!).getByTestId('trash-item-restore-btn'));
    await whenIdle();
    expect(toast.items.at(-1)).toMatchObject({ kind: 'error', message: 'The saved content of parser.ts is gone: Git has cleaned it up.' });
    await waitFor(() => expect(fake.callsOf('discard_list').length).toBeGreaterThanOrEqual(2));
  });

  it('a path that is in the way and an entry that vanished get their own messages', async () => {
    const fake = await openPanel();
    fake.reject('discard_restore', { code: 'INVALID_ARGUMENT', message: 'x', details: { field: 'paths', reason: 'blocked', paths: ['notes.txt'] } } satisfies AppError);
    await userEvent.click(within(screen.getAllByTestId('trash-item')[1]!).getByTestId('trash-item-restore-btn'));
    await whenIdle();
    expect(toast.items.at(-1)).toMatchObject({ kind: 'error', message: 'Cannot restore notes.txt: a file or folder is in the way.' });
    fake.reject('discard_restore', { code: 'NOT_FOUND', message: 'x', details: { what: 'discarded', id: 'a1' } } satisfies AppError);
    await userEvent.click(within(screen.getAllByTestId('trash-item')[1]!).getByTestId('trash-item-restore-btn'));
    await whenIdle();
    expect(toast.items.at(-1)).toMatchObject({ kind: 'info', message: 'This discarded file is no longer in the list.' });
  });

  it('restoring is refused while a write is in flight, with the reason', async () => {
    await openPanel();
    const end = op.begin('Fetch');
    await waitFor(() => expect(within(screen.getAllByTestId('trash-item')[0]!).getByTestId('trash-item-restore-btn')).toBeDisabled());
    expect(within(screen.getAllByTestId('trash-item')[0]!).getByTestId('trash-item-restore-btn')).toHaveAttribute('title', expect.stringContaining('Fetch'));
    end();
  });

  it('restoring stays available while a merge or rebase is stopped on conflicts', async () => {
    const fake = await openPanel({ discard_restore: () => result(['notes.txt']) });
    op.setState(makeConflictState());
    const button = within(screen.getAllByTestId('trash-item')[1]!).getByTestId('trash-item-restore-btn');
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    await whenIdle();
    expect(fake.callsOf('discard_restore')).toHaveLength(1);
  });

  it('reloads after a worktree or index change (once per burst), not for refs or head', async () => {
    const fake = await openPanel();
    // The settling of the stores waits on real timers: only the debounce is faked, once the panel is up.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      expect(fake.callsOf('discard_list')).toHaveLength(1);
      fake.emit('repo:changed', { repoId: 1, kinds: ['head', 'refs'] });
      await vi.advanceTimersByTimeAsync(400);
      expect(fake.callsOf('discard_list')).toHaveLength(1);
      fake.emit('repo:changed', { repoId: 1, kinds: ['worktree'] });
      fake.emit('repo:changed', { repoId: 1, kinds: ['index'] });
      fake.emit('repo:changed', { repoId: 1, kinds: ['worktree', 'index'] });
      await vi.advanceTimersByTimeAsync(400);
      expect(fake.callsOf('discard_list')).toHaveLength(2);
      // Another repository's events are not ours.
      fake.emit('repo:changed', { repoId: 2, kinds: ['worktree'] });
      await vi.advanceTimersByTimeAsync(400);
      expect(fake.callsOf('discard_list')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the list is a roving list of Restore buttons: ArrowDown moves between rows', async () => {
    await openPanel();
    const buttons = screen.getAllByTestId('trash-item-restore-btn');
    buttons[0]!.focus();
    expect(buttons.map((b) => b.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    await userEvent.keyboard('{ArrowDown}');
    expect(buttons[1]).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(buttons[2]).toHaveFocus();
  });
});

describe('recovery tabs', () => {
  async function drawer() {
    const fake = await openTestRepo({ discard_list: () => ENTRIES, reflog_list: () => [] });
    render(CenterArea);
    return fake;
  }

  it('the Discarded tab opens the discarded files in place of the reflog and back', async () => {
    await drawer();
    ui.openDrawer('reflog-panel');
    expect(await screen.findByTestId('reflog-panel')).toBeInTheDocument();
    expect(tid('recovery-tab-reflog')).toHaveAttribute('aria-selected', 'true');
    expect(tid('recovery-tab-discarded')).toHaveAttribute('aria-selected', 'false');

    await userEvent.click(tid('recovery-tab-discarded'));
    expect(await screen.findByTestId('discard-trash-panel')).toBeInTheDocument();
    expect(maybe('reflog-panel')).toBeNull();
    expect(ui.drawer).toBe('discard-trash-panel');
    expect(tid('recovery-tab-discarded')).toHaveAttribute('aria-selected', 'true');
    expect(tid('recovery-tab-discarded')).toHaveFocus();

    await userEvent.click(tid('recovery-tab-reflog'));
    expect(await screen.findByTestId('reflog-panel')).toBeInTheDocument();
    expect(maybe('discard-trash-panel')).toBeNull();
  });

  it('arrow keys and Home / End move between the tabs and keep the focus on the selected one', async () => {
    await drawer();
    ui.openDrawer('reflog-panel');
    await screen.findByTestId('reflog-panel');
    tid('recovery-tab-reflog').focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(await screen.findByTestId('discard-trash-panel')).toBeInTheDocument();
    await waitFor(() => expect(tid('recovery-tab-discarded')).toHaveFocus());
    await userEvent.keyboard('{ArrowRight}');
    expect(await screen.findByTestId('reflog-panel')).toBeInTheDocument();
    await waitFor(() => expect(tid('recovery-tab-reflog')).toHaveFocus());
    await userEvent.keyboard('{End}');
    expect(await screen.findByTestId('discard-trash-panel')).toBeInTheDocument();
    await userEvent.keyboard('{Home}');
    expect(await screen.findByTestId('reflog-panel')).toBeInTheDocument();
  });

  it('only the selected tab is in the tab order, and the tablist is named', async () => {
    await drawer();
    ui.openDrawer('discard-trash-panel');
    await screen.findByTestId('discard-trash-panel');
    expect(tid('recovery-tab-discarded')).toHaveAttribute('tabindex', '0');
    expect(tid('recovery-tab-reflog')).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tablist')).toHaveAccessibleName('Recovery');
  });

  it('both panels close from their own button, and Escape closes the drawer', async () => {
    await drawer();
    ui.openDrawer('discard-trash-panel');
    await userEvent.click(await screen.findByTestId('trash-close-btn'));
    expect(ui.drawer).toBeNull();
    ui.openDrawer('reflog-panel');
    await userEvent.click(await screen.findByTestId('reflog-close-btn'));
    expect(ui.drawer).toBeNull();
  });

  it('the reflog panel keeps its select and list next to the tabs', async () => {
    await openTestRepo({ reflog_list: () => [], discard_list: () => [] });
    render(ReflogPanel, { props: { close: () => undefined } });
    await whenIdle();
    expect(tid('reflog-ref-select')).toBeInTheDocument();
    expect(tid('reflog-empty')).toBeInTheDocument();
  });
});

describe('view.discarded action', () => {
  it('toggles the drawer, and is refused without a repository', async () => {
    expect(actionDisabledReason(getAction('view.discarded')!, actionContext())).toBe('No repository open');
    await openTestRepo();
    expect(actionDisabledReason(getAction('view.discarded')!, actionContext())).toBeNull();
    await runAction('view.discarded');
    expect(ui.drawer).toBe('discard-trash-panel');
    await runAction('view.discarded');
    expect(ui.drawer).toBeNull();
  });
});

describe('toast after a discard', () => {
  async function discardOne(handlers: Record<string, () => unknown> = {}) {
    const fake = await openTestRepo({ discard_paths: () => makeStatus({ files: [] }), discard_list: () => ENTRIES, ...handlers });
    render(DialogHost);
    render(ToastContainer);
    const done = discardFiles([file('notes.txt')]);
    await userEvent.click(await screen.findByTestId('confirm-dialog-confirm-btn'));
    expect(await done).toBe(true);
    await whenIdle();
    return fake;
  }

  it('says what was discarded and offers to recover it: the button opens the discarded files', async () => {
    await discardOne();
    const recover = await screen.findByTestId('toast-recover-btn');
    expect(recover).toHaveTextContent('Recover');
    expect(recover.closest('[data-testid="toast"]')).toHaveTextContent('Discarded 1 file.');
    expect(ui.drawer).toBeNull();
    await userEvent.click(recover);
    expect(ui.drawer).toBe('discard-trash-panel');
  });

  it('a discard that fails announces nothing', async () => {
    const fake = await openTestRepo({ discard_list: () => ENTRIES });
    fake.reject('discard_paths', { code: 'GIT_FAILED', message: 'The backup before cancellation failed: no changes were cancelled.', details: {} } satisfies AppError);
    render(DialogHost);
    render(ToastContainer);
    const done = discardFiles([file('notes.txt')]);
    await userEvent.click(await screen.findByTestId('confirm-dialog-confirm-btn'));
    await done;
    await whenIdle();
    expect(maybe('toast-recover-btn')).toBeNull();
  });
});
