// `wt-panel` (05): lists, buttons, display confirmation, multiple selection, keyboard, conflicts, virtualization.
import { screen, within, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { op } from '$lib/stores/op.svelte';
import { status } from '$lib/stores/status.svelte';
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
      { stage_paths: () => snapshot([]), unstage_paths: () => snapshot([]) },
      [unstaged('a.txt'), unstaged('b.txt', 'untracked'), staged('c.txt')],
    );
    mountWithDialogs(WtPanel);
    await userEvent.click(within(items('wt-staged-item')[0]!).getByTestId('wt-unstage-file-btn'));
    expect(fake.callsOf('unstage_paths')[0]!.args).toEqual({ repoId: 1, paths: ['c.txt'] });
    await whenIdle();
    status.apply(snapshot([unstaged('a.txt'), unstaged('b.txt', 'untracked'), staged('c.txt')]));
    await userEvent.click(screen.getByTestId('wt-stage-all-btn'));
    expect(fake.callsOf('stage_paths')[0]!.args).toEqual({ repoId: 1, paths: 'all' });
    await whenIdle();
    status.apply(snapshot([staged('c.txt')]));
    await userEvent.click(screen.getByTestId('wt-unstage-all-btn'));
    expect(fake.callsOf('unstage_paths')[1]!.args).toEqual({ repoId: 1, paths: 'all' });
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
