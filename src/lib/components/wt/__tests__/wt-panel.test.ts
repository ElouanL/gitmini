// `wt-panel` (05): lists, buttons, display confirmation, multiple selection, keyboard, conflicts, virtualization.
import { screen, within, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveMenu } from '$lib/menus/registry';
import { op } from '$lib/stores/op.svelte';
import { status } from '$lib/stores/status.svelte';
import { toast } from '$lib/stores/toast.svelte';
import { ui } from '$lib/stores/ui.svelte';
import { whenIdle } from '$lib/activity';
import '../../dialogs-base/register';
import '../register';
import WtPanel from '../WtPanel.svelte';
import { file, mountWithDialogs, opState, setup, snapshot } from './helpers';
import type { FileStatus } from '$lib/ipc/types';
import type { FakeTransport } from '$lib/test/fake-transport';

let fake: FakeTransport;
const unstaged = (path: string, kind: FileStatus['unstaged'] = 'modified', over: Partial<FileStatus> = {}) => file(path, { unstaged: kind, ...over });
const staged = (path: string, kind: FileStatus['staged'] = 'modified', over: Partial<FileStatus> = {}) => file(path, { staged: kind, ...over });
const items = (id: string) => screen.queryAllByTestId(id);
const paths = (id: string) => items(id).map((e) => e.getAttribute('data-path'));

beforeEach(() => {
  fake = setup();
});

describe('listes (STAGE-01)', () => {
  it("separates no staged and staged; a partial file is in both; row attributes", async () => {
    setup({}, [
      unstaged('mod.txt'),
      staged('staged.txt', 'added'),
      file('both.txt', { staged: 'modified', unstaged: 'modified' }),
      unstaged('untracked.txt', 'untracked'),
      staged('new.txt', 'renamed', { oldPath: 'old.txt' }),
    ]);
    mountWithDialogs(WtPanel);
    expect(paths('wt-unstaged-item')).toEqual(['mod.txt', 'both.txt', 'untracked.txt']);
    expect(paths('wt-staged-item')).toEqual(['staged.txt', 'both.txt', 'new.txt']);
    expect(screen.getByTestId('wt-unstaged-list')).toHaveAttribute('data-count', '3');
    const untracked = items('wt-unstaged-item').find((e) => e.getAttribute('data-path') === 'untracked.txt')!;
    expect(untracked).toHaveAttribute('data-change', 'untracked');
    const renamed = items('wt-staged-item').find((e) => e.getAttribute('data-path') === 'new.txt')!;
    expect(renamed).toHaveAttribute('data-change', 'renamed');
    expect(renamed).toHaveTextContent('old.txt → new.txt');
    expect(screen.queryByTestId('wt-conflict-list')).toBeNull();
  });

  it("Internship: a click on wt-stage-file-btn sends stage_paths; the answer updates the list (not optimistic)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fake = setup(
      {
        stage_paths: async () => {
          await gate;
          return snapshot([staged('mod.txt'), staged('staged.txt', 'added')]);
        },
      },
      [unstaged('mod.txt'), staged('staged.txt', 'added')],
    );
    mountWithDialogs(WtPanel);
    const row = items('wt-unstaged-item')[0]!;
    await userEvent.click(within(row).getByTestId('wt-stage-file-btn'));
    // No optimistic updates: the line remains in "No staged" until the answer is there.
    expect(paths('wt-unstaged-item')).toEqual(['mod.txt']);
    expect(row).toHaveAttribute('data-pending', 'true');
    release();
    await whenIdle();
    await waitFor(() => expect(paths('wt-unstaged-item')).toEqual([]));
    expect(paths('wt-staged-item')).toEqual(['mod.txt', 'staged.txt']);
    expect(fake.callsOf('stage_paths')).toHaveLength(1);
  });

  it("Unstage and \"All stage\" / \"All unstage\" : paths and \"all\"", async () => {
    fake = setup(
      { stage_all: () => snapshot([]), unstage_paths: () => snapshot([]) },
      [unstaged('a.txt'), unstaged('b.txt', 'untracked'), staged('c.txt')],
    );
    mountWithDialogs(WtPanel);
    await userEvent.click(within(items('wt-staged-item')[0]!).getByTestId('wt-unstage-file-btn'));
    expect(fake.callsOf('unstage_paths')[0]!.args).toEqual({ repoId: 1, paths: ['c.txt'] });
    await whenIdle();
    status.apply(snapshot([unstaged('a.txt'), unstaged('b.txt', 'untracked'), staged('c.txt')]));
    await userEvent.click(screen.getByTestId('wt-stage-all-btn'));
    expect(fake.callsOf('stage_all')[0]!.args).toEqual({ repoId: 1, scope: 'all' });
    await whenIdle();
    status.apply(snapshot([staged('c.txt')]));
    await userEvent.click(screen.getByTestId('wt-unstage-all-btn'));
    expect(fake.callsOf('unstage_paths')[1]!.args).toEqual({ repoId: 1, paths: 'all' });
  });

  it("\"Stage tracked\" sends scope \"tracked\"; disabled with only untracked files, unless the status is truncated", async () => {
    fake = setup({ stage_all: () => snapshot([unstaged('b.txt', 'untracked'), staged('a.txt')]) }, [unstaged('a.txt'), unstaged('b.txt', 'untracked')]);
    mountWithDialogs(WtPanel);
    expect(screen.getByTestId('wt-stage-all-btn')).toHaveAttribute('title', 'Stage all, including untracked files');
    await userEvent.click(screen.getByTestId('wt-stage-tracked-btn'));
    expect(fake.callsOf('stage_all')[0]!.args).toEqual({ repoId: 1, scope: 'tracked' });
    await whenIdle();
    expect(paths('wt-unstaged-item')).toEqual(['b.txt']);
    expect(screen.getByTestId('wt-stage-tracked-btn')).toBeDisabled();
    expect(screen.getByTestId('wt-stage-all-btn')).toBeEnabled();

    status.apply(snapshot([unstaged('b.txt', 'untracked')], { truncated: true }));
    await waitFor(() => expect(screen.getByTestId('wt-stage-tracked-btn')).toBeEnabled());
  });

  it("bulk staging during a conflict: the conflicted files are left alone and a toast says how many", async () => {
    const conflicts = [file('c1.txt', { conflict: 'both-modified' }), file('c2.txt', { conflict: 'both-added' })];
    fake = setup({ stage_all: () => snapshot([...conflicts, staged('a.txt')]) }, [...conflicts, unstaged('a.txt')]);
    op.setState(opState({ conflictedPaths: ['c1.txt', 'c2.txt'] }));
    mountWithDialogs(WtPanel);
    await userEvent.click(screen.getByTestId('wt-stage-all-btn'));
    await whenIdle();
    expect(fake.callsOf('stage_all')[0]!.args).toEqual({ repoId: 1, scope: 'all' });
    expect(screen.getByTestId('wt-conflict-list')).toHaveAttribute('data-count', '2');
    expect(toast.items.at(-1)?.message).toBe('2 conflicted files left untouched: mark each one as resolved.');
  });

  it("menu wip: \"Stage tracked\" and \"Stage all\" before \"Discard all\"", async () => {
    fake = setup({ stage_all: () => snapshot([]) }, [unstaged('a.txt'), unstaged('b.txt', 'untracked')]);
    const menu = resolveMenu({ menu: 'wip' });
    const ids = menu.map((i) => i.id);
    expect(ids.indexOf('stage-tracked')).toBeLessThan(ids.indexOf('stage-all'));
    expect(ids.indexOf('stage-all')).toBeLessThan(ids.indexOf('discard-all'));
    const item = (id: string) => menu.find((i) => i.id === id)!;
    expect(item('stage-tracked').label).toBe('Stage tracked changes');
    expect(item('stage-all').label).toBe('Stage all, including untracked files');
    await item('stage-tracked').run();
    await whenIdle();
    expect(fake.callsOf('stage_all')[0]!.args).toEqual({ repoId: 1, scope: 'tracked' });

    // Only untracked files: "Stage tracked" is not offered.
    setup({}, [unstaged('b.txt', 'untracked')]);
    expect(resolveMenu({ menu: 'wip' }).map((i) => i.id)).not.toContain('stage-tracked');
  });

  it("submodule and path no UTF-8: reading alone, no internship or discard", () => {
    setup({}, [unstaged('lib', 'modified', { submodule: true }), unstaged('bad�.txt', 'untracked', { nonUtf8: true }), unstaged('ok.txt')]);
    mountWithDialogs(WtPanel);
    const [lib, bad, ok] = items('wt-unstaged-item');
    expect(lib).toHaveAttribute('data-submodule', 'true');
    expect(bad).toHaveAttribute('data-readonly', 'true');
    for (const ro of [lib!, bad!]) {
      expect(within(ro).queryByTestId('wt-stage-file-btn')).toBeNull();
      expect(within(ro).queryByTestId('wt-discard-file-btn')).toBeNull();
    }
    expect(within(ok!).getByTestId('wt-stage-file-btn')).toBeInTheDocument();
  });

  it("Truncated list: wt-truncated-banner", () => {
    setup({}, [unstaged('a')], { truncated: true });
    mountWithDialogs(WtPanel);
    expect(screen.getByTestId('wt-truncated-banner')).toHaveTextContent("More than 10,000 changes");
  });

  it("indicator ahead/behind when the upstream is known", () => {
    setup({}, [], { upstream: 'origin/main', ahead: 2, behind: 1 });
    mountWithDialogs(WtPanel);
    expect(screen.getByTestId('wt-ahead-behind')).toHaveAttribute('data-ahead', '2');
    expect(screen.getByTestId('wt-ahead-behind')).toHaveTextContent('↑2 ↓1');
  });
});

describe("date card with confirmation (STAGE-05)", () => {
  it("cancelled and confirmed: discard_paths is sent only after confirmation", async () => {
    fake = setup({ discard_paths: () => snapshot([]) }, [unstaged('mod.txt')]);
    mountWithDialogs(WtPanel);
    await userEvent.click(within(items('wt-unstaged-item')[0]!).getByTestId('wt-discard-file-btn'));
    const dlg = await screen.findByTestId('confirm-dialog');
    expect(dlg).toHaveAttribute('data-action', 'discard');
    expect(dlg).toHaveAttribute('data-danger', 'true');
    expect(dlg).toHaveTextContent("Discard changes to 1 file");
    await userEvent.click(screen.getByTestId('confirm-dialog-cancel-btn'));
    await whenIdle();
    expect(fake.callsOf('discard_paths')).toHaveLength(0);

    await userEvent.click(within(items('wt-unstaged-item')[0]!).getByTestId('wt-discard-file-btn'));
    await userEvent.click(await screen.findByTestId('confirm-dialog-confirm-btn'));
    await whenIdle();
    expect(fake.callsOf('discard_paths')[0]!.args).toEqual({ repoId: 1, paths: ['mod.txt'] });
  });

  it("\"Cancel All\": confirmation and then path \"all\"; files not tracked reported", async () => {
    fake = setup({ discard_paths: () => snapshot([]) }, [unstaged('a'), unstaged('b', 'untracked'), unstaged('lib', 'modified', { submodule: true })]);
    mountWithDialogs(WtPanel);
    await userEvent.click(screen.getByTestId('wt-discard-all-btn'));
    const dlg = await screen.findByTestId('confirm-dialog');
    expect(dlg).toHaveTextContent("2 files");
    expect(dlg).toHaveTextContent("deleted from the disk");
    await userEvent.click(screen.getByTestId('confirm-dialog-confirm-btn'));
    await whenIdle();
    expect(fake.callsOf('discard_paths')[0]!.args).toEqual({ repoId: 1, paths: 'all' });
  });
});

describe("multiple selection and keyboard", () => {
  const files = ['a.txt', 'b.txt', 'c.txt', 'd.txt'].map((p) => unstaged(p));

  it("Shift+click (beach) then stage from a selection line: one stage_paths with all selection", async () => {
    fake = setup({ stage_paths: () => snapshot([]) }, files);
    mountWithDialogs(WtPanel);
    const rows = items('wt-unstaged-item');
    const user = userEvent.setup();
    await user.click(rows[0]!);
    await user.keyboard('{Shift>}');
    await user.click(rows[2]!);
    await user.keyboard('{/Shift}');
    expect(rows.map((r) => r.getAttribute('data-selected'))).toEqual(['true', 'true', 'true', null]);
    await user.click(within(rows[1]!).getByTestId('wt-stage-file-btn'));
    expect(fake.callsOf('stage_paths')[0]!.args).toEqual({ repoId: 1, paths: ['a.txt', 'b.txt', 'c.txt'] });
  });

  it("a simple click opens the diff in the central area (source unstaged / staged)", async () => {
    setup({}, [unstaged('a.txt'), staged('s.txt')]);
    mountWithDialogs(WtPanel);
    await userEvent.click(items('wt-unstaged-item')[0]!);
    expect(ui.centerView.id).toBe('diff');
    expect(ui.centerView.props).toMatchObject({ path: 'a.txt', source: { kind: 'unstaged' } });
    await userEvent.click(items('wt-staged-item')[0]!);
    expect(ui.centerView.props).toMatchObject({ path: 's.txt', source: { kind: 'staged' } });
  });

  it("keyboard: ▼ moves focus, `s` internalships the focused file, `Enter` opens the diff", async () => {
    fake = setup({ stage_paths: () => snapshot([unstaged('a.txt'), unstaged('c.txt'), unstaged('d.txt'), staged('b.txt')]) }, files);
    mountWithDialogs(WtPanel);
    const list = within(screen.getByTestId('wt-unstaged-list')).getByRole('listbox');
    list.focus();
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('s');
    await whenIdle();
    expect(fake.callsOf('stage_paths')[0]!.args).toEqual({ repoId: 1, paths: ['b.txt'] });
    await waitFor(() => expect(paths('wt-staged-item')).toEqual(['b.txt']));
    // The focus goes to the following file: one can chain.
    await userEvent.keyboard('{Enter}');
    expect(ui.centerView.props).toMatchObject({ path: 'c.txt', source: { kind: 'unstaged' } });
  });

  it("`Delete` Opens Checkout Confirmation", async () => {
    setup({}, files);
    mountWithDialogs(WtPanel);
    const list = within(screen.getByTestId('wt-unstaged-list')).getByRole('listbox');
    list.focus();
    await userEvent.keyboard('{Delete}');
    expect(await screen.findByTestId('confirm-dialog')).toHaveAttribute('data-action', 'discard');
  });

  it("`u` does nothing in \"No staged\", `s` does nothing in \"Staged\"", async () => {
    fake = setup({}, [unstaged('a.txt'), staged('b.txt')]);
    mountWithDialogs(WtPanel);
    const un = within(screen.getByTestId('wt-unstaged-list')).getByRole('listbox');
    un.focus();
    await userEvent.keyboard('u');
    const st = within(screen.getByTestId('wt-staged-list')).getByRole('listbox');
    st.focus();
    await userEvent.keyboard('s');
    expect(fake.calls.filter((c) => c.command.endsWith('_paths'))).toHaveLength(0);
  });
});

describe('conflits (RBC-02, RBC-07)', () => {
  const kinds = ['both-modified', 'both-added', 'both-deleted', 'added-by-us', 'added-by-them', 'deleted-by-us', 'deleted-by-them'] as const;

  it("each ConflictKind: wt-conflict-resolve-btn and wt-open-external-btn, no buttons Keep / Delete / Discard", async () => {
    fake = setup({ stage_paths: () => snapshot([]) }, kinds.map((k) => file(`${k}.txt`, { conflict: k })));
    op.setState(opState({ kind: 'rebase', conflictedPaths: kinds.map((k) => `${k}.txt`) }));
    mountWithDialogs(WtPanel);
    const list = screen.getByTestId('wt-conflict-list');
    expect(list).toHaveAttribute('data-kind', 'rebase');
    const rows = within(list).getAllByTestId('wt-conflict-item');
    expect(rows.map((r) => r.getAttribute('data-conflict-kind'))).toEqual([...kinds]);
    for (const row of rows) {
      expect(within(row).getByTestId('wt-conflict-resolve-btn')).toHaveTextContent("Mark as resolved");
      expect(within(row).queryByTestId('wt-discard-file-btn')).toBeNull();
      expect(within(row).queryByTestId('wt-stage-file-btn')).toBeNull();
      expect(within(row).queryByText(/Garder|Deleteimer/)).toBeNull();
    }
    // A conflict appears only in the conflict section.
    expect(items('wt-unstaged-item')).toHaveLength(0);
    // "mark as resolved" = stage_paths, including for deleted-by-us.
    await userEvent.click(within(rows[5]!).getByTestId('wt-conflict-resolve-btn'));
    expect(fake.callsOf('stage_paths')[0]!.args).toEqual({ repoId: 1, paths: ['deleted-by-us.txt'] });
  });

  it("a click on a conflict opens the diff `conflict` (markers); the first conflict is selected ex officio", async () => {
    setup({}, [file('c.txt', { conflict: 'both-modified' })]);
    op.setState(opState({ kind: 'rebase', conflictedPaths: ['c.txt'] }));
    mountWithDialogs(WtPanel);
    await waitFor(() => expect(items('wt-conflict-item')[0]).toHaveAttribute('data-selected', 'true'));
    expect(ui.centerView.id).toBe('graph');
    await userEvent.click(items('wt-conflict-item')[0]!);
    expect(ui.centerView.props).toMatchObject({ path: 'c.txt', source: { kind: 'conflict', view: 'markers' } });
  });

  it("stash application conflict (no operation): data-kind=none and message \"stash is kept\"", () => {
    setup({}, [file('s.txt', { conflict: 'both-modified' })]);
    mountWithDialogs(WtPanel);
    const list = screen.getByTestId('wt-conflict-list');
    expect(list).toHaveAttribute('data-kind', 'none');
    expect(list).toHaveTextContent("The stash is stored. Resolve and mark as resolved.");
  });

  it('wt-open-external-btn : open_external { kind: "file", path }', async () => {
    fake = setup({ open_external: () => null }, [file('c.txt', { conflict: 'both-modified' })]);
    op.setState(opState({ kind: 'rebase', conflictedPaths: ['c.txt'] }));
    mountWithDialogs(WtPanel);
    await userEvent.click(screen.getByTestId('wt-open-external-btn'));
    expect(fake.callsOf('open_external')[0]!.args).toEqual({ repoId: 1, target: { kind: 'file', path: 'c.txt', line: null } });
  });
});

describe('take ours / theirs (RSV-01)', () => {
  const c = (path: string, conflict: NonNullable<FileStatus['conflict']> = 'both-modified', over: Partial<FileStatus> = {}) => file(path, { conflict, ...over });
  const menu = (...files: FileStatus[]) => resolveMenu({ menu: 'wt-file', file: files[0]!, files });
  const listbox = () => within(screen.getByTestId('wt-conflict-list')).getByRole('listbox');

  it('the context menu of conflicted files offers both sides, named after the operation', () => {
    setup({}, [c('a.txt')]);
    op.setState(opState({ kind: 'rebase', conflictedPaths: ['a.txt'] }));
    expect(menu(c('a.txt')).map((i) => [i.id, i.label, i.disabled])).toEqual(
      expect.arrayContaining([['resolve-ours', 'Take ours: Base (onto)', false], ['resolve-theirs', 'Take theirs: Your commit', false]]),
    );
    op.setState(opState({ kind: 'merge', incoming: 'refs/heads/feature', conflictedPaths: ['a.txt'] }));
    expect(menu(c('a.txt')).find((i) => i.id === 'resolve-theirs')!.label).toBe('Take theirs: feature');
    // More than one file: the count is part of the label.
    expect(menu(c('a.txt'), c('b.txt')).find((i) => i.id === 'resolve-ours')!.label).toBe('Take ours: HEAD (2 files)');
  });

  it('the entries are masked when there is nothing to take: no conflict, both sides deleted, read only', () => {
    setup();
    const ids = (...files: FileStatus[]) => menu(...files).map((i) => i.id);
    expect(ids(unstaged('plain.txt'))).not.toContain('resolve-ours');
    expect(ids(c('gone.txt', 'both-deleted'))).not.toContain('resolve-theirs');
    expect(ids(c('lib', 'both-modified', { submodule: true }))).not.toContain('resolve-ours');
    expect(ids(c('bad', 'both-added', { nonUtf8: true }))).not.toContain('resolve-ours');
    expect(ids(c('a.txt'), unstaged('plain.txt'))).not.toContain('resolve-ours');
    expect(ids(c('a.txt'), c('gone.txt', 'both-deleted'))).toContain('resolve-ours');
  });

  it('the entries are disabled while another write is running', () => {
    setup();
    const end = op.begin('Fetch', null);
    expect(menu(c('a.txt')).filter((i) => i.id.startsWith('resolve-')).map((i) => i.disabled)).toEqual([true, true]);
    end();
  });

  it('a menu entry sends the selected conflicts in one resolve_paths and the answer updates the list', async () => {
    const files = [c('a.txt'), c('b.txt'), c('c.txt')];
    fake = setup({ resolve_paths: () => snapshot([c('c.txt')]) }, files);
    op.setState(opState({ kind: 'merge', conflictedPaths: files.map((f) => f.path) }));
    mountWithDialogs(WtPanel);
    expect(paths('wt-conflict-item')).toEqual(['a.txt', 'b.txt', 'c.txt']);
    await menu(files[0]!, files[1]!).find((i) => i.id === 'resolve-theirs')!.run();
    await whenIdle();
    expect(fake.callsOf('resolve_paths')[0]!.args).toEqual({ repoId: 1, paths: ['a.txt', 'b.txt'], side: 'theirs' });
    await waitFor(() => expect(paths('wt-conflict-item')).toEqual(['c.txt']));
  });

  it('keyboard: `o` takes ours and `t` takes theirs for the focused conflict, the focus moves on', async () => {
    const files = [c('a.txt'), c('b.txt')];
    fake = setup({ resolve_paths: () => snapshot([c('b.txt')]) }, files);
    op.setState(opState({ kind: 'rebase', conflictedPaths: ['a.txt', 'b.txt'] }));
    mountWithDialogs(WtPanel);
    listbox().focus();
    await waitFor(() => expect(items('wt-conflict-item')[0]).toHaveClass('focused'));
    await userEvent.keyboard('o');
    await whenIdle();
    expect(fake.callsOf('resolve_paths')[0]!.args).toEqual({ repoId: 1, paths: ['a.txt'], side: 'ours' });
    await waitFor(() => expect(paths('wt-conflict-item')).toEqual(['b.txt']));
    expect(items('wt-conflict-item')[0]).toHaveClass('focused');
    // The key acts without asking, so a toast says what was taken for which file, and where the old content went.
    expect(toast.items.at(-1)?.message).toBe('Took ours for a.txt: Base (onto). What the file held before is kept in Discarded files.');

    // The last conflict takes its list with it: what runs after the write must not read the list that is gone (Svelte warns of it).
    const warn = vi.spyOn(console, 'warn');
    fake.on('resolve_paths', () => snapshot([]));
    await userEvent.keyboard('t');
    await whenIdle();
    expect(fake.callsOf('resolve_paths')[1]!.args).toEqual({ repoId: 1, paths: ['b.txt'], side: 'theirs' });
    await waitFor(() => expect(screen.queryByTestId('wt-conflict-list')).toBeNull());
    await waitFor(() => expect(toast.items.at(-1)?.message).toBe('Took theirs for b.txt: Your commit. What the file held before is kept in Discarded files.'));
    await whenIdle();
    expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([]);
  });

  it('`o` and `t` do nothing outside the conflict list, nor on a read only conflict', async () => {
    fake = setup({}, [unstaged('a.txt'), c('lib', 'both-modified', { submodule: true })]);
    op.setState(opState({ kind: 'merge', conflictedPaths: ['lib'] }));
    mountWithDialogs(WtPanel);
    within(screen.getByTestId('wt-unstaged-list')).getByRole('listbox').focus();
    await userEvent.keyboard('ot');
    listbox().focus();
    await waitFor(() => expect(items('wt-conflict-item')[0]).toHaveClass('focused'));
    await userEvent.keyboard('ot');
    expect(fake.callsOf('resolve_paths')).toHaveLength(0);
  });

  it('a file that is no longer in conflict refreshes the status and shows the error', async () => {
    fake = setup({ status_get: () => snapshot([]) }, [c('a.txt')]);
    op.setState(opState({ kind: 'merge', conflictedPaths: ['a.txt'] }));
    fake.reject('resolve_paths', { code: 'INVALID_ARGUMENT', message: 'The file is no longer in conflict.', details: { field: 'paths', reason: 'not-conflicted', paths: ['a.txt'] } });
    mountWithDialogs(WtPanel);
    const before = fake.callsOf('status_get').length;
    await menu(c('a.txt')).find((i) => i.id === 'resolve-ours')!.run();
    await whenIdle();
    expect(fake.callsOf('status_get').length).toBeGreaterThan(before);
    await waitFor(() => expect(items('wt-conflict-item')).toHaveLength(0));
  });
});

describe('virtualisation (02 §4)', () => {
  it("from 500 entries the list only makes one window, under 500 it makes all", () => {
    const many = Array.from({ length: 10_000 }, (_, i) => unstaged(`dir/f${String(i).padStart(5, '0')}.txt`, 'untracked'));
    setup({}, many);
    mountWithDialogs(WtPanel);
    const list = screen.getByTestId('wt-unstaged-list');
    expect(list).toHaveAttribute('data-count', '10000');
    expect(list).toHaveAttribute('data-virtual', 'true');
    expect(items('wt-unstaged-item').length).toBeGreaterThan(5);
    expect(items('wt-unstaged-item').length).toBeLessThan(100);
  });

  it("499 entries: all returned", () => {
    setup({}, Array.from({ length: 499 }, (_, i) => unstaged(`f${i}.txt`)));
    mountWithDialogs(WtPanel);
    expect(items('wt-unstaged-item')).toHaveLength(499);
    expect(screen.getByTestId('wt-unstaged-list')).not.toHaveAttribute('data-virtual');
  });
});
