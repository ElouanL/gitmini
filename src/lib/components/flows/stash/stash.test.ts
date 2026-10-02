// "stash" stream (08): save (toolbar and dialog), apply / pop (conflicts, INDEX_CONFLICT), drop cancelable, branch, retail panel, menus.
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { whenIdle } from '$lib/activity';
import { runAction } from '$lib/actions/registry';
import DialogHost from '$lib/components/dialogs-base/DialogHost.svelte';
import '$lib/components/dialogs-base/register';
import ToastContainer from '$lib/components/toast/ToastContainer.svelte';
import '$lib/register-core';
import { openDialog } from '$lib/dialogs/registry';
import type { AppError, StashEntry, StashFiles } from '$lib/ipc/types';
import { resolveMenu } from '$lib/menus/registry';
import { graph } from '$lib/stores/graph.svelte';
import { refs } from '$lib/stores/refs.svelte';
import { ui } from '$lib/stores/ui.svelte';
import { makeStashes, makeStatus, makeUndo } from '$lib/test/fixtures';
import { resetAll } from '$lib/test/reset';
import { openTestRepo } from '../test-support';
import './register';
import StashDetailPanel from './StashDetailPanel.svelte';
import { stashUi } from './stash-state.svelte';

const tid = (id: string) => screen.getByTestId(id);
const maybe = (id: string) => screen.queryByTestId(id);

beforeEach(() => {
  resetAll({ keepRegistrations: true });
  stashUi.reset();
});

const err = (code: AppError['code'], details: Record<string, unknown> = {}, message: string = code): AppError => ({ code, message, details });
const file = (path: string, change: StashFiles['worktree'][number]['change'] = 'modified', additions = 2, deletions = 1) => ({ path, oldPath: null, change, additions, deletions, binary: false, submodule: null });
const FILES: StashFiles = { worktree: [file('mod.txt'), file('b.txt')], index: [file('staged.txt', 'added', 3, 0)], untracked: [file('untracked.txt', 'untracked', 1, 0)] };

async function setup(handlers: Record<string, () => unknown> = {}, stashes: StashEntry[] = makeStashes()) {
  const fake = await openTestRepo({
    stash_list: () => stashes,
    stash_show: () => FILES,
    status_get: () => makeStatus(),
    ...handlers,
  });
  render(DialogHost);
  render(ToastContainer);
  await whenIdle();
  return fake;
}

describe('save', () => {
  it("toolbar-stash-btn (action stash.save): immediate, not followed, without message", async () => {
    const created = makeStashes()[0]!;
    const fake = await setup({ stash_save: () => ({ created, list: [created] }) });
    await runAction('stash.save');
    await whenIdle();
    expect(fake.callsOf('stash_save')[0]!.args).toEqual({ repoId: 1, includeUntracked: true, keepIndex: false });
    expect(refs.stashes).toEqual([created]);
  });

  it("nothing to stasher (created = null): toast information, no error", async () => {
    await setup({ stash_save: () => ({ created: null, list: makeStashes() }) });
    await runAction('stash.save');
    const toast = await screen.findByTestId('toast');
    expect(toast).toHaveAttribute('data-kind', 'info');
    expect(toast).toHaveTextContent("No changes to be set aside.");
  });

  it("disabled on clean worktree or during a state-of-the-art operation", async () => {
    await setup({ status_get: () => makeStatus({ files: [] }) });
    const { actionContext, actionDisabledReason, getAction } = await import('$lib/actions/registry');
    expect(actionDisabledReason(getAction('stash.save')!, actionContext())).toBe("Nothing to set aside: the worktree is clean");
  });

  it("stash-save-dialog: default values, message, keep index", async () => {
    const fake = await setup({ stash_save: () => ({ created: null, list: [] }) });
    void openDialog('stash-save-dialog', {});
    await screen.findByTestId('stash-save-dialog');
    expect(tid('stash-include-untracked-checkbox')).toBeChecked();
    expect(tid('stash-keep-index-checkbox')).not.toBeChecked();
    expect(tid('stash-message-input')).toHaveAttribute('placeholder', 'WIP on main');
    expect(maybe('stash-paths-list')).toBeNull();
    await userEvent.type(tid('stash-message-input'), 'wip test');
    await userEvent.click(tid('stash-include-untracked-checkbox'));
    await userEvent.click(tid('stash-keep-index-checkbox'));
    await userEvent.click(tid('stash-save-confirm-btn'));
    await whenIdle();
    expect(fake.callsOf('stash_save')[0]!.args).toEqual({ repoId: 1, message: 'wip test', includeUntracked: false, keepIndex: true });
    expect(maybe('stash-save-dialog')).toBeNull();
  });

  it("empty message: no `message` key (git key)", async () => {
    const fake = await setup({ stash_save: () => ({ created: null, list: [] }) });
    void openDialog('stash-save-dialog', {});
    await screen.findByTestId('stash-save-dialog');
    await userEvent.type(tid('stash-message-input'), '   ');
    await userEvent.click(tid('stash-save-confirm-btn'));
    await whenIdle();
    expect(fake.callsOf('stash_save')[0]!.args).not.toHaveProperty('message');
  });

  it("paths: removeable list, validation with remaining paths; Cancel does not launch anything", async () => {
    const fake = await setup({ stash_save: () => ({ created: null, list: [] }) });
    void openDialog('stash-save-dialog', { paths: ['mod.txt', 'a b.txt'] });
    await screen.findByTestId('stash-save-dialog');
    expect(screen.getAllByTestId('stash-paths-item').map((e) => e.getAttribute('data-path'))).toEqual(['mod.txt', 'a b.txt']);
    await userEvent.click(within(screen.getAllByTestId('stash-paths-item')[1]!).getByTestId('stash-paths-remove-btn'));
    expect(screen.getAllByTestId('stash-paths-item')).toHaveLength(1);
    await userEvent.click(tid('stash-save-confirm-btn'));
    await whenIdle();
    expect(fake.callsOf('stash_save')[0]!.args).toMatchObject({ paths: ['mod.txt'], includeUntracked: true });
  });

  it("no path: validation disabled", async () => {
    await setup();
    void openDialog('stash-save-dialog', { paths: ['mod.txt'] });
    await screen.findByTestId('stash-save-dialog');
    await userEvent.click(tid('stash-paths-remove-btn'));
    expect(tid('stash-save-confirm-btn')).toBeDisabled();
    await userEvent.click(tid('stash-save-cancel-btn'));
    expect(maybe('stash-save-dialog')).toBeNull();
  });

  it("path refused (submodule): error under the list, dialog remains open", async () => {
    const fake = await setup();
    fake.reject('stash_save', err('INVALID_ARGUMENT', { field: 'paths', reason: 'submodule' }, "lib/ is a submodule: edit it from its own repository."));
    void openDialog('stash-save-dialog', { paths: ['lib'] });
    await screen.findByTestId('stash-save-dialog');
    await userEvent.click(tid('stash-save-confirm-btn'));
    await whenIdle();
    expect(tid('stash-save-error')).toHaveTextContent("lib/ is a submodule");
    expect(maybe('toast')).toBeNull();
    expect(tid('stash-save-dialog')).toBeInTheDocument();
  });

  it("action stash.save-paths (menu wt-file): pre-filled dialog, submodules and not UTF-8 discarded", async () => {
    await setup();
    const f = (path: string, extra: object = {}) => ({ path, oldPath: null, staged: null, unstaged: 'modified' as const, conflict: null, oldMode: null, newMode: null, submodule: null, nonUtf8: null, ...extra });
    const target = { menu: 'wt-file' as const, file: f('mod.txt'), files: [f('mod.txt'), f('lib', { submodule: true }), f('c.txt')] };
    const items = resolveMenu(target);
    expect(items.map((i) => i.id)).toContain('stash-paths');
    void items.find((i) => i.id === 'stash-paths')!.run();
    await screen.findByTestId('stash-save-dialog');
    expect(screen.getAllByTestId('stash-paths-item').map((e) => e.getAttribute('data-path'))).toEqual(['mod.txt', 'c.txt']);
    // Submodule: masked entrance.
    expect(resolveMenu({ menu: 'wt-file', file: f('lib', { submodule: true }) }).map((i) => i.id)).not.toContain('stash-paths');
    expect(resolveMenu({ menu: 'wt-file', file: f('x', { nonUtf8: true }) }).map((i) => i.id)).not.toContain('stash-paths');
  });
});

describe('apply / pop (08 §Apply / Pop)', () => {
  it("toolbar-pop-btn : pop of stash@{0}, without restoring the index", async () => {
    const fake = await setup({ stash_pop: () => ({ conflicts: [], dropped: true, list: makeStashes().slice(1) }) });
    await runAction('stash.pop');
    await whenIdle();
    expect(fake.callsOf('stash_pop')[0]!.args).toEqual({ repoId: 1, oid: makeStashes()[0]!.oid, index: 0, restoreIndex: false });
    expect(refs.stashes).toHaveLength(1);
  });

  it("conflict: this is not an error — toast information, stash saved, line WIP selected", async () => {
    const list = makeStashes();
    await setup({ stash_apply: () => ({ conflicts: ['s.txt'], list }) });
    graph.selectStash(list[0]!.oid, 0);
    render(StashDetailPanel);
    await whenIdle();
    await userEvent.click(tid('stash-apply-btn'));
    await whenIdle();
    const toast = await screen.findByTestId('toast');
    expect(toast).toHaveAttribute('data-kind', 'info');
    expect(toast).toHaveTextContent("Conflict: stash@{0} was kept. Resolve the files, then drop the stash if you no longer need it.");
    expect(refs.stashes).toHaveLength(2);
    expect(graph.selection.kind).toBe('wip');
    expect(maybe('op-banner')).toBeNull();
  });

  it("pop in conflict (dropped = false): stash retained, same ad", async () => {
    const list = makeStashes();
    await setup({ stash_pop: () => ({ conflicts: ['s.txt'], dropped: false, list }) });
    await runAction('stash.pop');
    expect(await screen.findByText(/Conflict: stash@\{0\} was kept/)).toBeInTheDocument();
    expect(refs.stashes).toHaveLength(2);
  });

  it("INDEX_CONFLICT with --index: stash-retry-without-index-btn (restoreIndex false), no toast", async () => {
    const list = makeStashes();
    const fake = await setup({ stash_apply: () => ({ conflicts: [], list }) });
    fake.reject('stash_apply', err('INDEX_CONFLICT', {}, 'Conflicts in index'));
    graph.selectStash(list[1]!.oid, 1);
    render(StashDetailPanel);
    await whenIdle();
    await userEvent.click(tid('stash-restore-index-checkbox'));
    await userEvent.click(tid('stash-apply-btn'));
    await whenIdle();
    expect(fake.callsOf('stash_apply')[0]!.args).toMatchObject({ oid: list[1]!.oid, index: 1, restoreIndex: true });
    expect(tid('stash-index-conflict')).toHaveTextContent("Could not restore index. Try again without?");
    expect(maybe('toast')).toBeNull();
    await userEvent.click(tid('stash-retry-without-index-btn'));
    await whenIdle();
    expect(fake.callsOf('stash_apply')[1]!.args).toMatchObject({ oid: list[1]!.oid, restoreIndex: false });
    expect(maybe('stash-retry-without-index-btn')).toBeNull();
  });

  it("INDEX_CONFLICT from a pop: The Indexless Recovery is a pop", async () => {
    const list = makeStashes();
    const fake = await setup({ stash_pop: () => ({ conflicts: [], dropped: true, list: list.slice(1) }) });
    fake.reject('stash_pop', err('INDEX_CONFLICT'));
    graph.selectStash(list[0]!.oid, 0);
    render(StashDetailPanel);
    await whenIdle();
    await userEvent.click(tid('stash-restore-index-checkbox'));
    await userEvent.click(tid('stash-pop-btn'));
    await whenIdle();
    await userEvent.click(tid('stash-retry-without-index-btn'));
    await whenIdle();
    expect(fake.callsOf('stash_pop')).toHaveLength(2);
    expect(fake.callsOf('stash_pop')[1]!.args).toMatchObject({ restoreIndex: false });
  });

  it("stash disappeared out of the app (NOT_FOUND stash): toast and list reread", async () => {
    const list = makeStashes();
    const fake = await setup({}, list);
    fake.reject('stash_pop', err('NOT_FOUND', { what: 'stash' }, "This stash no longer exists."));
    await runAction('stash.pop');
    await whenIdle();
    expect(await screen.findByText("This stash no longer exists.")).toBeInTheDocument();
    expect(fake.callsOf('stash_list').length).toBeGreaterThanOrEqual(2);
  });
});

describe('drop (08 §Drop, 11 §1)', () => {
  it("without confirmation: stash_drop with oid ET index, toast[data-kind=undo] and then undo_last with captured Id", async () => {
    const list = makeStashes();
    const entry = { ...makeUndo().entry!, id: 'undo-drop', kind: 'stash-drop' as const, refName: null, stashMessage: 'On feature/login: experiment', stashOid: list[1]!.oid, label: 'Restaurer le stash' };
    const fake = await setup({
      stash_drop: () => ({ list: list.slice(0, 1) }),
      undo_peek: () => ({ entry, available: true, reason: null, head: 'a'.repeat(40) }),
      undo_last: () => ({ head: { branch: 'main', oid: 'a'.repeat(40), detached: false, unborn: false } }),
    });
    const item = resolveMenu({ menu: 'stash', stash: list[1]! }).find((i) => i.id === 'stash-drop')!;
    expect(item.danger).toBe(true);
    await item.run();
    await whenIdle();
    expect(maybe('confirm-dialog')).toBeNull();
    expect(fake.callsOf('stash_drop')[0]!.args).toEqual({ repoId: 1, oid: list[1]!.oid, index: 1 });
    const toast = await screen.findByTestId('toast');
    expect(toast).toHaveAttribute('data-kind', 'undo');
    expect(toast).toHaveTextContent(`stash@{1} "experiment" deleted (was at ${list[1]!.oid.slice(0, 7)})`);
    await userEvent.click(tid('toast-undo-btn'));
    await whenIdle();
    expect(fake.callsOf('undo_last')[0]!.args).toEqual({ repoId: 1, entryId: 'undo-drop', expectedHead: 'a'.repeat(40) });
  });

  it("renumbering: the index sent is that of the list of the front, the guard is backend side (identity = oid)", async () => {
    const list = makeStashes();
    const fake = await setup({ stash_drop: () => ({ list: [] }) });
    graph.selectStash(list[1]!.oid, 1);
    render(StashDetailPanel);
    await whenIdle();
    await userEvent.click(tid('stash-drop-btn'));
    await whenIdle();
    expect(fake.callsOf('stash_drop')[0]!.args).toMatchObject({ oid: list[1]!.oid, index: 1 });
    // The deleted stash was selected: more details to display.
    expect(graph.selection.kind).toBe('wip');
  });

  it("drop allowed during a state operation (does not touch HEAD or the index)", async () => {
    await setup();
    const { op } = await import('$lib/stores/op.svelte');
    const { makeConflictState } = await import('$lib/test/fixtures');
    op.setState(makeConflictState());
    const items = resolveMenu({ menu: 'stash', stash: makeStashes()[0]! });
    expect(items.find((i) => i.id === 'stash-drop')!.disabled).toBe(false);
    expect(items.find((i) => i.id === 'stash-apply')!.disabled).toBe(true);
    expect(items.find((i) => i.id === 'stash-pop')!.disabled).toBe(true);
    expect(items.find((i) => i.id === 'stash-branch')!.disabled).toBe(true);
  });
});

describe("stash-detail-panel (08 §Detail of a stash)", () => {
  it("message, branch, files per part; one click opens the diff `stash` in the central area", async () => {
    const list = makeStashes();
    const fake = await setup({}, list);
    graph.selectStash(list[0]!.oid, 0);
    render(StashDetailPanel);
    await whenIdle();
    const panel = tid('stash-detail-panel');
    expect(panel).toHaveTextContent('stash@{0} · wip parser');
    expect(panel).toHaveTextContent('main');
    expect(fake.callsOf('stash_show')[0]!.args).toEqual({ repoId: 1, oid: list[0]!.oid });
    const items = await screen.findAllByTestId('stash-detail-file-item');
    expect(items.map((e) => [e.getAttribute('data-part'), e.getAttribute('data-path')])).toEqual([
      ['worktree', 'mod.txt'],
      ['worktree', 'b.txt'],
      ['index', 'staged.txt'],
      ['untracked', 'untracked.txt'],
    ]);
    expect(items[2]).toHaveAttribute('data-change', 'added');
    expect(panel).toHaveTextContent("Modified");
    expect(panel).toHaveTextContent("Staged");
    expect(panel).toHaveTextContent("Untracked");
    await userEvent.click(items[2]!);
    expect(ui.centerView).toEqual({ id: 'diff', props: { path: 'staged.txt', source: { kind: 'stash', oid: list[0]!.oid, part: 'index' } } });
  });

  it("Actions: Apply / Pop / Drop / Branch, restore default unchecked index", async () => {
    const list = makeStashes();
    await setup({}, list);
    graph.selectStash(list[0]!.oid, 0);
    render(StashDetailPanel);
    await whenIdle();
    for (const id of ['stash-apply-btn', 'stash-pop-btn', 'stash-drop-btn', 'stash-branch-btn']) expect(tid(id)).toBeEnabled();
    expect(tid('stash-restore-index-checkbox')).not.toBeChecked();
    expect(maybe('stash-retry-without-index-btn')).toBeNull();
  });

  it("stash could not be found (list not yet updated): message, no calls stash_show", async () => {
    const fake = await setup({}, []);
    graph.selectStash('9'.repeat(40), 0);
    render(StashDetailPanel);
    await whenIdle();
    expect(tid('stash-detail-gone')).toHaveTextContent("This stash no longer exists.");
    expect(fake.callsOf('stash_show')).toHaveLength(0);
  });

  it("another stash reloads files (identity = oid)", async () => {
    const list = makeStashes();
    const fake = await setup({}, list);
    graph.selectStash(list[0]!.oid, 0);
    render(StashDetailPanel);
    await whenIdle();
    graph.selectStash(list[1]!.oid, 1);
    await waitFor(() => expect(fake.callsOf('stash_show')).toHaveLength(2));
    expect(fake.callsOf('stash_show')[1]!.args).toMatchObject({ oid: list[1]!.oid });
  });
});

describe("branch from a stash (08)", () => {
  it("Proposed name stash/<branche>-<n>; stash_branch then toast", async () => {
    const list = makeStashes();
    const fake = await setup({ stash_branch: () => ({ branch: 'from-stash', conflicts: [], list: list.slice(0, 1) }) }, list);
    void openDialog('stash-branch-dialog', { stash: list[1] });
    await screen.findByTestId('stash-branch-dialog');
    expect((tid('stash-branch-name-input') as HTMLInputElement).value).toBe('stash/feature/login-1');
    await userEvent.clear(tid('stash-branch-name-input'));
    await userEvent.type(tid('stash-branch-name-input'), 'from-stash');
    await userEvent.click(tid('stash-branch-confirm-btn'));
    await whenIdle();
    expect(fake.callsOf('stash_branch')[0]!.args).toEqual({ repoId: 1, oid: list[1]!.oid, index: 1, name: 'from-stash' });
    expect(maybe('stash-branch-dialog')).toBeNull();
    expect(await screen.findByText("from-stash Branch created from stash@{1}")).toBeInTheDocument();
  });

  it("ALREADY_EXISTS and INVALID_ARGUMENT under the field (stash-branch-error), never toasted", async () => {
    const list = makeStashes();
    const fake = await setup({}, list);
    void openDialog('stash-branch-dialog', { stash: list[0] });
    await screen.findByTestId('stash-branch-dialog');
    fake.reject('stash_branch', err('ALREADY_EXISTS', { what: 'branch', name: 'stash/main-0' }));
    await userEvent.click(tid('stash-branch-confirm-btn'));
    await whenIdle();
    expect(tid('stash-branch-error')).toHaveTextContent("The stash/main-0 branch already exists.");
    fake.reject('stash_branch', err('INVALID_ARGUMENT', { field: 'name' }, "Invalid branch name."));
    await userEvent.click(tid('stash-branch-confirm-btn'));
    await whenIdle();
    expect(tid('stash-branch-error')).toHaveTextContent("Invalid branch name.");
    expect(maybe('toast')).toBeNull();
    await userEvent.clear(tid('stash-branch-name-input'));
    await userEvent.click(tid('stash-branch-confirm-btn'));
    expect(tid('stash-branch-error')).toHaveTextContent("Enter a branch name.");
  });

  it("conflict during application: announced as for application, line WIP selected", async () => {
    const list = makeStashes();
    await setup({ stash_branch: () => ({ branch: 'b', conflicts: ['x.txt'], list }) }, list);
    void openDialog('stash-branch-dialog', { stash: list[0] });
    await screen.findByTestId('stash-branch-dialog');
    await userEvent.click(tid('stash-branch-confirm-btn'));
    await whenIdle();
    // `Ok { branch, conflicts }`: branch is created (toast), conflict is announced as for apply, stash is retained, WIP selected
    expect(await screen.findByText("b Branch created from stash@{0}")).toBeInTheDocument();
    expect(await screen.findByText(/Conflict: stash@\{0\} was kept/)).toBeInTheDocument();
    expect(refs.stashes).toHaveLength(2);
    expect(graph.selection.kind).toBe('wip');
  });
});

describe('menus', () => {
  it("stash menu: apply, pop, branch, show, drop (bottom, danger) — selection via stash-show", async () => {
    await setup();
    const list = makeStashes();
    const items = resolveMenu({ menu: 'stash', stash: list[0]! });
    expect(items.map((i) => i.id)).toEqual(['stash-apply', 'stash-pop', 'stash-branch', 'stash-show', 'stash-drop']);
    expect(items.at(-1)!.separatorBefore).toBe(true);
    void items.find((i) => i.id === 'stash-show')!.run();
    expect(graph.selection).toEqual({ kind: 'stash', oid: list[0]!.oid, index: 0 });
  });

  it("wip menu: stash-save opens the dialog (grows on worktree clean)", async () => {
    await setup();
    const item = resolveMenu({ menu: 'wip' }).find((i) => i.id === 'stash-save')!;
    expect(item.disabled).toBe(false);
    void item.run();
    expect(await screen.findByTestId('stash-save-dialog')).toBeInTheDocument();
  });
});
