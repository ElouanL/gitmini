// undo feed and security (11): undo-confirm-dialog (Mod+Z, toolbar), reflog-panel, STALE, warning LFS, toast-retry-btn (BUSY lock).
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { whenIdle } from '$lib/activity';
import { runAction } from '$lib/actions/registry';
import { handleGlobalKeydown } from '$lib/actions/dispatcher';
import DialogHost from '$lib/components/dialogs-base/DialogHost.svelte';
import '$lib/components/dialogs-base/register';
import ToastContainer from '$lib/components/toast/ToastContainer.svelte';
import '$lib/register-core';
import { openDialog } from '$lib/dialogs/registry';
import type { AppError, ReflogEntry, UndoEntry, UndoStatus } from '$lib/ipc/types';
import { graph } from '$lib/stores/graph.svelte';
import { repo } from '$lib/stores/repo.svelte';
import { toast } from '$lib/stores/toast.svelte';
import { ui } from '$lib/stores/ui.svelte';
import { makeLogPage, makeRepoInfo, makeStatus, makeUndo, oid } from '$lib/test/fixtures';
import { resetAll } from '$lib/test/reset';
import { openTestRepo } from '../test-support';
import ReflogPanel from './ReflogPanel.svelte';
import '../branches/register';
import './register';

const tid = (id: string) => screen.getByTestId(id);
const maybe = (id: string) => screen.queryByTestId(id);

beforeEach(() => {
  resetAll({ keepRegistrations: true });
});

const HEAD = 'a'.repeat(40);
const entry = (over: Partial<UndoEntry>): UndoEntry => ({ ...makeUndo().entry!, ...over });
const status = (e: UndoEntry): UndoStatus => ({ entry: e, available: true, reason: null, head: HEAD });
const wip = { head: { branch: 'main', oid: oid(59), detached: false, unborn: false } };

describe('undo-confirm-dialog', () => {
  it("toolbar-undo-btn / Mod+Z (undo.last) : data-kind dialog, description of , initial focus on Cancel", async () => {
    const e = entry({ id: 'u9', kind: 'commit', label: "Cancel the commit \"feat: x\"" });
    await openTestRepo({ undo_peek: () => status(e) });
    render(DialogHost);
    await whenIdle();
    void runAction('undo.last');
    const dlg = await screen.findByTestId('undo-confirm-dialog');
    expect(dlg).toHaveAttribute('data-kind', 'commit');
    expect(tid("undo-confirm-description")).toHaveTextContent("Undo commit \"feat: x\"; changes remain staged.");
    expect(tid('undo-cancel-btn')).toHaveFocus();
  });

  it("Mod+Z off entry field opens the dialog; in an input field it does nothing", async () => {
    await openTestRepo({ undo_peek: () => status(entry({})) });
    render(DialogHost);
    const input = document.createElement('input');
    document.body.appendChild(input);
    await whenIdle();
    input.focus();
    window.addEventListener('keydown', handleGlobalKeydown);
    try {
      const press = (target: HTMLElement) => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
      press(input);
      await whenIdle();
      expect(maybe('undo-confirm-dialog')).toBeNull();
      press(document.body);
      expect(await screen.findByTestId('undo-confirm-dialog')).toBeInTheDocument();
    } finally {
      window.removeEventListener('keydown', handleGlobalKeydown);
      input.remove();
    }
  });

  it("confirm: undo_last with entryId and expectedHead (HEAD d的undo_peek), success toast, closed dialogue", async () => {
    const e = entry({ id: 'u9' });
    const fake = await openTestRepo({ undo_peek: () => status(e), undo_last: () => wip });
    render(DialogHost);
    render(ToastContainer);
    await whenIdle();
    void runAction('undo.last');
    await userEvent.click(await screen.findByTestId('undo-confirm-btn'));
    await whenIdle();
    expect(fake.callsOf('undo_last')[0]!.args).toEqual({ repoId: 1, entryId: 'u9', expectedHead: HEAD });
    expect(maybe('undo-confirm-dialog')).toBeNull();
    expect(await screen.findByText(`Undone: ${e.label}. The previous state remains in the reflog.`)).toBeInTheDocument();
  });

  it("Cancel does not run any commands", async () => {
    const fake = await openTestRepo({ undo_peek: () => status(entry({})), undo_last: () => wip });
    render(DialogHost);
    await whenIdle();
    void runAction('undo.last');
    await userEvent.click(await screen.findByTestId('undo-cancel-btn'));
    expect(maybe('undo-confirm-dialog')).toBeNull();
    expect(fake.callsOf('undo_last')).toHaveLength(0);
  });

  it("STALE { what: \"undo\" }: toast \"Another operation has taken place since.\" and undo_peek restarted", async () => {
    const fake = await openTestRepo({ undo_peek: () => status(entry({})) });
    render(DialogHost);
    render(ToastContainer);
    await whenIdle();
    fake.reject('undo_last', { code: 'STALE', message: "expired", details: { what: 'undo' } } satisfies AppError);
    const peeks = fake.callsOf('undo_peek').length;
    void runAction('undo.last');
    await userEvent.click(await screen.findByTestId('undo-confirm-btn'));
    await whenIdle();
    expect(await screen.findByText("Another operation has taken place since then.")).toBeInTheDocument();
    expect(fake.callsOf('undo_peek').length).toBeGreaterThan(peeks);
    expect(maybe('undo-confirm-dialog')).toBeNull();
  });

  it("DIRTY_WORKTREE (rest --keep refused): toast, entry remains", async () => {
    const fake = await openTestRepo({ undo_peek: () => status(entry({ kind: 'merge', label: "Cancel feature merge in hand" })) });
    render(DialogHost);
    render(ToastContainer);
    await whenIdle();
    fake.reject('undo_last', { code: 'DIRTY_WORKTREE', message: "Local changes on 1 file affected by the cancellation: a.rs.", details: { paths: ['a.rs'] } });
    void runAction('undo.last');
    expect(await screen.findByTestId("undo-confirm-description")).toHaveTextContent("Cancel feature merge in main; main returns to");
    await userEvent.click(tid('undo-confirm-btn'));
    await whenIdle();
    expect(await screen.findByText(/Local changes on 1 file/)).toBeInTheDocument();
    expect(maybe('undo-confirm-dialog')).toBeNull();
  });

  it("only one kind per text: the 9 Kinds open the dialogue with their data-kind", async () => {
    const kinds = ['commit', 'amend', 'merge', 'rebase', 'cherry-pick', 'revert', 'pull', 'branch-delete', 'stash-drop'] as const;
    await openTestRepo();
    render(DialogHost);
    for (const kind of kinds) {
      void openDialog('undo-confirm-dialog', { entry: entry({ kind, stashMessage: 'On main: x' }), expectedHead: HEAD });
      expect(await screen.findByTestId('undo-confirm-dialog')).toHaveAttribute('data-kind', kind);
      expect(tid("undo-confirm-description").textContent!.length).toBeGreaterThan(10);
      await userEvent.click(tid('undo-cancel-btn'));
    }
  });
});

describe("toolbar-undo-btn: Availability Infobull (11 §IU)", () => {
  it("not available: the text of the motif (UndoBlockReason)", async () => {
    await openTestRepo({ undo_peek: () => ({ entry: entry({ pushed: true }), available: false, reason: 'pushed', head: HEAD }) });
    const { undo } = await import('$lib/stores/undo.svelte');
    await undo.peekNow();
    expect(undo.tooltip).toBe("Cannot undo an operation that has already been published.");
    const { actionContext, actionDisabledReason, getAction } = await import('$lib/actions/registry');
    expect(actionDisabledReason(getAction('undo.last')!, actionContext())).toBe("Cannot undo an operation that has already been published.");
  });
  it("available: entry language", async () => {
    await openTestRepo({ undo_peek: () => status(entry({ label: "Cancel the commit \"feat: x\"" })) });
    const { undo } = await import('$lib/stores/undo.svelte');
    await undo.peekNow();
    expect(undo.tooltip).toBe("Cancel the commit \"feat: x\"");
  });
});

describe('reflog-panel (11 §UI)', () => {
  const entries: ReflogEntry[] = [
    { index: 0, oid: oid(60), previous: oid(59), message: 'commit: feat: login form', time: 1_790_000_000 },
    { index: 1, oid: oid(59), previous: oid(58), message: 'checkout: moving from feature to main', time: 1_789_990_000 },
    { index: 2, oid: oid(58), previous: oid(57), message: 'reset: moving to HEAD~1', time: 1_789_980_000 },
  ];

  async function openPanel(handlers: Record<string, () => unknown> = {}) {
    const fake = await openTestRepo({ reflog_list: () => entries, log_page: () => makeLogPage(), ...handlers });
    render(DialogHost);
    render(ReflogPanel, { props: { close: () => ui.closeDrawer() } });
    await whenIdle();
    return fake;
  }

  it("50 entries from HEAD, from the latest to the oldest: HEAD@{n}, SHA short, message, data-index / data-oid", async () => {
    const fake = await openPanel();
    expect(fake.callsOf('reflog_list')[0]!.args).toEqual({ repoId: 1, ref: 'HEAD', limit: 50 });
    const items = screen.getAllByTestId('reflog-item');
    expect(items.map((i) => i.getAttribute('data-index'))).toEqual(['0', '1', '2']);
    expect(items.map((i) => i.getAttribute('data-oid'))).toEqual([oid(60), oid(59), oid(58)]);
    expect(items[0]).toHaveTextContent('HEAD@{0}');
    expect(items[0]).toHaveTextContent(oid(60).slice(0, 7));
    expect(items[0]).toHaveTextContent('commit: feat: login form');
  });

  it("reference selector: a local branch rereads its reflog", async () => {
    const fake = await openPanel();
    await userEvent.selectOptions(tid('reflog-ref-select'), 'feature/login');
    await whenIdle();
    expect(fake.callsOf('reflog_list')[1]!.args).toEqual({ repoId: 1, ref: 'feature/login', limit: 50 });
    expect(screen.getAllByTestId('reflog-item')[0]).toHaveTextContent('feature/login@{0}');
  });

  it("click on a line: selects the commit if loaded in the graph", async () => {
    await openPanel();
    graph.setPages([makeLogPage()]);
    await userEvent.click(within(screen.getAllByTestId('reflog-item')[1]!).getAllByRole('button')[0]!);
    await whenIdle();
    expect(graph.selection).toEqual({ kind: 'commits', oids: [oid(59)], anchor: oid(59) });
  });

  it("reflog-item-create-branch-btn: branch-create-dialog with startPoint = oid; detached checkout without confirmation", async () => {
    const fake = await openPanel({ branch_checkout: () => ({ head: { kind: 'detached', oid: oid(58) }, local: [], remote: [], tags: [] }) });
    const rows = screen.getAllByTestId('reflog-item');
    await userEvent.click(within(rows[2]!).getByTestId('reflog-item-create-branch-btn'));
    expect(await screen.findByTestId('branch-create-dialog')).toBeInTheDocument();
    expect(tid('branch-create-start-point')).toHaveTextContent(oid(58).slice(0, 7));
    await userEvent.click(tid('branch-create-cancel-btn'));
    await userEvent.click(within(rows[2]!).getByTestId('reflog-item-checkout-btn'));
    await whenIdle();
    expect(maybe('confirm-dialog')).toBeNull();
    expect(fake.callsOf('branch_checkout')[0]!.args).toEqual({ repoId: 1, target: { kind: 'detached', oid: oid(58) } });
  });

  it("empty and wrong: messages, never toast", async () => {
    await openPanel({ reflog_list: () => [] });
    expect(tid('reflog-empty')).toHaveTextContent("No reflog entries.");
    expect(maybe('toast')).toBeNull();
  });

  it("refreshes on repo:changed { head | refs }", async () => {
    const fake = await openPanel();
    fake.emit('repo:changed', { repoId: 1, kinds: ['worktree'] });
    await whenIdle();
    expect(fake.callsOf('reflog_list')).toHaveLength(1);
    fake.emit('repo:changed', { repoId: 1, kinds: ['head', 'refs'] });
    await waitFor(() => expect(fake.callsOf('reflog_list')).toHaveLength(2));
  });
});

describe('guards (11 §3, §5, §7)', () => {
  it("Git LFS: a toast of information UNE times at the opening, never restored by refreshment", async () => {
    const fake = await openTestRepo({}, { lfs: true });
    render(ToastContainer);
    const toasts = await screen.findAllByTestId('toast');
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toHaveAttribute('data-kind', 'info');
    expect(toasts[0]).toHaveTextContent("This repository uses Git LFS. A gitmini clone does not download LFS files");
    toast.clear();
    fake.emit('repo:changed', { repoId: 1, kinds: ['refs', 'head', 'index', 'worktree'] });
    await whenIdle();
    expect(maybe('toast')).toBeNull();
    // Another repository LFS (new opening) the announcement again.
    repo.adopt(makeRepoInfo({ id: 2, workdir: '/r2', lfs: true }));
    await whenIdle();
    expect(await screen.findAllByTestId('toast')).toHaveLength(1);
  });

  it("repository without LFS: no toast", async () => {
    await openTestRepo();
    render(ToastContainer);
    await whenIdle();
    expect(maybe('toast')).toBeNull();
  });

  it("BUSY { reason: \"lock\" }: toast with the file and toast-retry-btn that restarts the same command (never delete)", async () => {
    const fake = await openTestRepo({ status_get: () => makeStatus(), stash_save: () => ({ created: null, list: [] }) });
    render(ToastContainer);
    await whenIdle();
    fake.reject('stash_save', { code: 'BUSY', message: 'verrou', details: { reason: 'lock', lockFile: '/r/.git/index.lock' } });
    await runAction('stash.save');
    await whenIdle();
    const t = await screen.findByTestId('toast');
    expect(t).toHaveTextContent('/r/.git/index.lock');
    await userEvent.click(tid('toast-retry-btn'));
    await whenIdle();
    expect(fake.callsOf('stash_save')).toHaveLength(2);
  });
});
