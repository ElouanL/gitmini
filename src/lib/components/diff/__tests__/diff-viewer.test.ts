// `diff-viewer` (05): lines and numbers, placeholders, hunks, diff expired, conflicts, refreshment, virtualization.
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { availableCommands } from '$lib/actions/palette';
import { runAction } from '$lib/actions/registry';
import { whenIdle } from '$lib/activity';
import { app } from '$lib/stores/app.svelte';
import type { DiffSource, FileDiff } from '$lib/ipc/types';
import { op } from '$lib/stores/op.svelte';
import { status } from '$lib/stores/status.svelte';
import { toast } from '$lib/stores/toast.svelte';
import { ui } from '$lib/stores/ui.svelte';
import type { FakeTransport } from '$lib/test/fake-transport';
import '../../dialogs-base/register';
import '../../wt/register';
import { file, fileDiff, hunk, mountWithDialogs, opState, setup, snapshot } from '../../wt/__tests__/helpers';
import DiffViewer from '../DiffViewer.svelte';

let fake: FakeTransport;
const tid = (id: string) => screen.getByTestId(id);
const lines = () => screen.queryAllByTestId('diff-line');

const MOD = fileDiff({
  hash: 'h-mod',
  stats: { added: 2, removed: 1 },
  hunks: [
    hunk([['ctx', 'line 3', 3, 3], ['del', 'line 4', 4, null], ['add', "line 4 (amended)", null, 4], ['ctx', 'line 5', 5, 5]], '@@ -3,3 +3,3 @@ fn a'),
    hunk([['ctx', 'line 19', 19, 19], ['add', "line added", null, 20], ['noeol', '\\ No newline at end of file', null, null]], '@@ -19 +19,2 @@'),
    hunk([['ctx', 'line 35', 35, 35]], '@@ -35 +35 @@'),
  ],
});

function mount(source: DiffSource, path = 'mod.txt') {
  return mountWithDialogs(DiffViewer, { path, source });
}

beforeEach(() => {
  fake = setup({ diff_file: () => MOD }, [file('mod.txt', { unstaged: 'modified' })]);
});

describe("Unified diff (DIFF-01, DIFF-04)", () => {
  it("diff_file { path, source } then lines with Kind and old / new numbers", async () => {
    mount({ kind: 'unstaged' });
    await waitFor(() => expect(lines()).toHaveLength(8));
    expect(fake.callsOf('diff_file')[0]!.args).toEqual({ repoId: 1, path: 'mod.txt', source: { kind: 'unstaged' }, contextLines: 3 });
    expect(tid('diff-viewer')).toHaveAttribute('data-source', 'unstaged');
    expect(screen.getAllByTestId('diff-hunk-header').map((h) => h.getAttribute('data-hunk-index'))).toEqual(['0', '1', '2']);
    expect(screen.getAllByTestId('diff-hunk-header')[0]).toHaveTextContent('@@ -3,3 +3,3 @@ fn a');
    const attrs = lines().map((l) => [l.getAttribute('data-kind'), l.getAttribute('data-old-no'), l.getAttribute('data-new-no')]);
    expect(attrs.slice(0, 4)).toEqual([['ctx', '3', '3'], ['del', '4', null], ['add', null, '4'], ['ctx', '5', '5']]);
    expect(attrs[6]).toEqual(['noeol', null, null]);
    expect(tid('diff-file-header')).toHaveTextContent('mod.txt');
    expect(tid('diff-stats')).toHaveTextContent('+2 −1');
  });

  it("CRLF: only the changed lines are add / del, the \\r is not displayed", async () => {
    fake.on('diff_file', () =>
      fileDiff({
        path: 'crlf.txt',
        hunks: [hunk([['ctx', 'line 1\r', 1, 1], ['del', 'line 2\r', 2, null], ['add', "line 2 as amended\r", null, 2], ['ctx', 'line 3\r', 3, 3]])],
      }),
    );
    mount({ kind: 'unstaged' }, 'crlf.txt');
    await waitFor(() => expect(lines()).toHaveLength(4));
    expect(lines().map((l) => l.getAttribute('data-kind'))).toEqual(['ctx', 'del', 'add', 'ctx']);
    expect(lines()[2]).toHaveTextContent("line 2 as amended");
    expect(lines()[2]!.textContent).not.toContain('\r');
  });

  it("header: rename \"old → new\" and change of mode", async () => {
    fake.on('diff_file', () => fileDiff({ path: 'new.txt', oldPath: 'old.txt', oldMode: 0o100644, newMode: 0o100755 }));
    mount({ kind: 'staged' }, 'new.txt');
    await waitFor(() => expect(tid('diff-file-header')).toHaveTextContent('old.txt → new.txt'));
    expect(tid('diff-file-header')).toHaveTextContent('100644 → 100755');
    expect(tid('diff-empty')).toHaveTextContent("Only the file mode changes");
  });

  it("a line of more than 2,000 characters is truncated with \"... (N characters)\"", async () => {
    fake.on('diff_file', () => fileDiff({ hunks: [hunk([['add', 'x'.repeat(5000), null, 1]])] }));
    mount({ kind: 'unstaged' });
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("... (5000 characters)");
    expect(lines()[0]!.textContent!.length).toBeLessThan(2100);
  });

  it('diff-close-btn revient au graphe', async () => {
    ui.openCenter('diff', { path: 'mod.txt', source: { kind: 'unstaged' } });
    mount({ kind: 'unstaged' });
    await userEvent.click(tid('diff-close-btn'));
    expect(ui.centerIsGraph).toBe(true);
  });
});

describe('placeholders (DIFF-02)', () => {
  it("binary: old sizes → new, no lines", async () => {
    fake.on('diff_file', () => fileDiff({ path: 'image.png', binary: true, oldSize: 12_700, newSize: 13_400 }));
    mount({ kind: 'unstaged' }, 'image.png');
    expect(await screen.findByTestId('diff-binary-placeholder')).toHaveTextContent(/binary file — 12\.4 KiB → 13\.1 KiB/);
    expect(lines()).toHaveLength(0);
  });

  it("big file: placeholder with size; \"load still\" restarts diff_file { force: true }", async () => {
    fake.on('diff_file', (a) =>
      a.force === true
        ? fileDiff({ path: 'big.txt', hunks: [hunk([['add', 'MODIFIED', null, 100]])] })
        : fileDiff({ path: 'big.txt', tooLarge: { bytes: 6 * 1024 * 1024, lines: 87_382, hardLimit: false } }),
    );
    mount({ kind: 'unstaged' }, 'big.txt');
    const ph = await screen.findByTestId('diff-large-placeholder');
    expect(ph).toHaveTextContent('6.0 MiB');
    expect(ph).toHaveTextContent('87');
    await userEvent.click(tid('diff-large-load-btn'));
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(fake.callsOf('diff_file').at(-1)!.args).toMatchObject({ path: 'big.txt', force: true });
    expect(screen.queryByTestId('diff-large-placeholder')).toBeNull();
  });

  it("beyond 10 Mio (hardLimit): not to \"load anyway\", only the publisher", async () => {
    fake.on('diff_file', () => fileDiff({ tooLarge: { bytes: 20 * 1024 * 1024, lines: 400_000, hardLimit: true } }));
    mount({ kind: 'unstaged' });
    await screen.findByTestId('diff-large-placeholder');
    expect(screen.queryByTestId('diff-large-load-btn')).toBeNull();
    expect(tid('diff-large-open-btn')).toBeInTheDocument();
  });

  it("submodule and pointer LFS", async () => {
    fake.on('diff_file', () => fileDiff({ path: 'lib', submodule: { oldOid: 'abc1234'.padEnd(40, '0'), newOid: 'def5678'.padEnd(40, '0'), dirty: true } }));
    mount({ kind: 'unstaged' }, 'lib');
    expect(await screen.findByTestId('diff-submodule-placeholder')).toHaveTextContent("Submodule: abc1234 → def5678 (modified)");
  });

  it("LFS pointer: above banner of the diff text", async () => {
    fake.on('diff_file', () => fileDiff({ path: 'a.bin', lfsPointer: true, hunks: [hunk([['add', 'version https://git-lfs.github.com/spec/v1', null, 1]])] }));
    mount({ kind: 'unstaged' }, 'a.bin');
    expect(await screen.findByTestId('diff-lfs-pointer-banner')).toHaveTextContent("Git pointer LFS");
    expect(lines()).toHaveLength(1);
  });
});

describe('hunks (STAGE-02, STAGE-08)', () => {
  it("internship: stage_hunk { path, diffHash, hunkIndex } without patch text; answer updates status, then diff is reloaded", async () => {
    fake.on('stage_hunk', () => snapshot([file('mod.txt', { staged: 'modified', unstaged: 'modified' })]));
    mount({ kind: 'unstaged' });
    await waitFor(() => expect(lines()).toHaveLength(8));
    const header = screen.getAllByTestId('diff-hunk-header')[1]!;
    await userEvent.click(within(header).getByTestId('diff-hunk-stage-btn'));
    await whenIdle();
    expect(fake.callsOf('stage_hunk')[0]!.args).toEqual({ repoId: 1, path: 'mod.txt', diffHash: 'h-mod', hunkIndex: 1, contextLines: 3 });
    expect(status.snapshot?.files[0]?.staged).toBe('modified');
    expect(fake.callsOf('diff_file').length).toBeGreaterThanOrEqual(2);
  });

  it("diff internshipd: only diff-hunk-unstage-btn; unstage_hunk", async () => {
    fake.on('unstage_hunk', () => snapshot([]));
    mount({ kind: 'staged' });
    await waitFor(() => expect(lines()).toHaveLength(8));
    expect(screen.queryAllByTestId('diff-hunk-stage-btn')).toHaveLength(0);
    expect(screen.queryAllByTestId('diff-hunk-discard-btn')).toHaveLength(0);
    await userEvent.click(within(screen.getAllByTestId('diff-hunk-header')[0]!).getByTestId('diff-hunk-unstage-btn'));
    await whenIdle();
    expect(fake.callsOf('unstage_hunk')[0]!.args).toMatchObject({ hunkIndex: 0, diffHash: 'h-mod' });
  });

  it("hunk display: confirm-dialog[data-action=discard] and then discard_hunk", async () => {
    fake.on('discard_hunk', () => snapshot([]));
    mount({ kind: 'unstaged' });
    await waitFor(() => expect(lines()).toHaveLength(8));
    await userEvent.click(within(screen.getAllByTestId('diff-hunk-header')[2]!).getByTestId('diff-hunk-discard-btn'));
    const dlg = await screen.findByTestId('confirm-dialog');
    expect(dlg).toHaveAttribute('data-action', 'discard');
    await userEvent.click(tid('confirm-dialog-cancel-btn'));
    await whenIdle();
    expect(fake.callsOf('discard_hunk')).toHaveLength(0);
    await userEvent.click(within(screen.getAllByTestId('diff-hunk-header')[2]!).getByTestId('diff-hunk-discard-btn'));
    await userEvent.click(await screen.findByTestId('confirm-dialog-confirm-btn'));
    await whenIdle();
    expect(fake.callsOf('discard_hunk')[0]!.args).toMatchObject({ hunkIndex: 2 });
  });

  it("STALE { what: \"diff\" }: silent charging, no toast, nothing is applied", async () => {
    mount({ kind: 'unstaged' });
    await waitFor(() => expect(lines()).toHaveLength(8));
    const before = fake.callsOf('diff_file').length;
    const fresh = fileDiff({ hash: 'h-new', stats: { added: 1, removed: 1 }, hunks: [hunk([['ctx', 'a', 1, 1], ['add', 'nouveau', null, 2]])] });
    fake.on('diff_file', () => fresh);
    fake.reject('stage_hunk', { code: 'STALE', message: "expired", details: { what: 'diff' } });
    await userEvent.click(within(screen.getAllByTestId('diff-hunk-header')[1]!).getByTestId('diff-hunk-stage-btn'));
    await whenIdle();
    await waitFor(() => expect(lines()).toHaveLength(2));
    expect(fake.callsOf('diff_file').length).toBeGreaterThan(before);
    expect(toast.items).toHaveLength(0);
    expect(status.snapshot?.files[0]?.staged).toBeNull();
  });

  it("keyboard : `s` on the hunk focused the internship", async () => {
    fake.on('stage_hunk', () => snapshot([]));
    mount({ kind: 'unstaged' });
    await waitFor(() => expect(lines()).toHaveLength(8));
    await userEvent.click(lines()[5]!); // a line of the 2nd hunk
    await userEvent.keyboard('s');
    await whenIdle();
    expect(fake.callsOf('stage_hunk')[0]!.args).toMatchObject({ hunkIndex: 1 });
  });

  it.each([
    ["binary", fileDiff({ binary: true, oldSize: 1, newSize: 2 })],
    ["large file", fileDiff({ tooLarge: { bytes: 2_000_000, lines: 30_000, hardLimit: false } })],
    ["submodule", fileDiff({ submodule: { oldOid: null, newOid: null, dirty: false } })],
  ])("no hunk button on: %s", async (_name, d: FileDiff) => {
    fake.on('diff_file', () => d);
    mount({ kind: 'unstaged' });
    await waitFor(() => expect(screen.queryByTestId('diff-loading')).toBeNull());
    expect(screen.queryAllByTestId('diff-hunk-stage-btn')).toHaveLength(0);
  });

  it("no hunk button on a non-UTF-8 path", async () => {
    setup({ diff_file: () => MOD }, [file('bad�.txt', { unstaged: 'modified', nonUtf8: true })]);
    mount({ kind: 'unstaged' }, 'bad�.txt');
    await waitFor(() => expect(lines()).toHaveLength(8));
    expect(screen.queryAllByTestId('diff-hunk-stage-btn')).toHaveLength(0);
  });
});

describe('lines (STAGE-10)', () => {
  // One hunk: ctx(0) del(1) del(2) add(3) add(4) ctx(5) add(6).
  const BLOCK = fileDiff({
    hash: 'h-block',
    stats: { added: 3, removed: 2 },
    hunks: [hunk([['ctx', 'a', 1, 1], ['del', 'b', 2, null], ['del', 'c', 3, null], ['add', 'B', null, 2], ['add', 'C', null, 3], ['ctx', 'd', 4, 4], ['add', 'e', null, 5]], '@@ -1,4 +1,5 @@')],
  });
  const gutter = (i: number) => within(lines()[i]!).getByTestId('diff-line-gutter');
  const picked = () => lines().map((l, i) => (l.getAttribute('data-selected') === 'true' ? i : -1)).filter((i) => i >= 0);
  const header = () => screen.getByTestId('diff-hunk-header');

  async function shiftClick(el: HTMLElement): Promise<void> {
    const user = userEvent.setup(); // the pressed Shift lives in the instance
    await user.keyboard('{Shift>}');
    await user.click(el);
    await user.keyboard('{/Shift}');
  }

  beforeEach(() => {
    fake = setup({ diff_file: () => BLOCK }, [file('mod.txt', { unstaged: 'modified' })]);
  });

  it("a click on the gutter of a change selects it; the hunk header then offers the actions for the lines", async () => {
    mount({ kind: 'unstaged' });
    await waitFor(() => expect(lines()).toHaveLength(7));
    expect(within(header()).getByTestId('diff-hunk-stage-btn')).toBeInTheDocument();
    await userEvent.click(gutter(1));
    expect(picked()).toEqual([1]);
    expect(within(header()).getByTestId('diff-lines-count')).toHaveTextContent('1 line selected');
    expect(within(header()).getByTestId('diff-lines-stage-btn')).toHaveTextContent('Stage line');
    expect(within(header()).getByTestId('diff-lines-discard-btn')).toHaveTextContent('Discard line');
    expect(within(header()).queryByTestId('diff-hunk-stage-btn')).toBeNull();
    expect(tid('diff-lines-status')).toHaveTextContent('1 line selected');
    // A second gutter click adds, a click on a selected one removes.
    await userEvent.click(gutter(4));
    expect(picked()).toEqual([1, 4]);
    expect(within(header()).getByTestId('diff-lines-stage-btn')).toHaveTextContent('Stage 2 lines');
    await userEvent.click(gutter(1));
    await userEvent.click(gutter(4));
    expect(picked()).toEqual([]);
    expect(within(header()).getByTestId('diff-hunk-stage-btn')).toBeInTheDocument();
  });

  it("context lines have no selection; a click on the text selects nothing and drops the selection", async () => {
    mount({ kind: 'unstaged' });
    await waitFor(() => expect(lines()).toHaveLength(7));
    await userEvent.click(gutter(0));
    await userEvent.click(gutter(5));
    expect(picked()).toEqual([]);
    await userEvent.click(gutter(2));
    expect(picked()).toEqual([2]);
    await userEvent.click(lines()[3]!);
    expect(picked()).toEqual([]);
  });

  it("Shift+click selects the changes between the anchor and the clicked line, context excluded", async () => {
    mount({ kind: 'unstaged' });
    await waitFor(() => expect(lines()).toHaveLength(7));
    await userEvent.click(gutter(2));
    await shiftClick(lines()[6]!);
    expect(picked()).toEqual([2, 3, 4, 6]);
    expect(within(header()).getByTestId('diff-lines-count')).toHaveTextContent('4 lines selected');
  });

  it("Stage lines: stage_hunk { hunkIndex, lines } without patch text, then the selection is gone and the diff reloaded", async () => {
    fake.on('stage_hunk', () => snapshot([file('mod.txt', { staged: 'modified', unstaged: 'modified' })]));
    mount({ kind: 'unstaged' });
    await waitFor(() => expect(lines()).toHaveLength(7));
    await userEvent.click(gutter(2));
    await shiftClick(lines()[3]!);
    await userEvent.click(within(header()).getByTestId('diff-lines-stage-btn'));
    await whenIdle();
    expect(fake.callsOf('stage_hunk')[0]!.args).toEqual({ repoId: 1, path: 'mod.txt', diffHash: 'h-block', hunkIndex: 0, contextLines: 3, lines: [2, 3] });
    expect(status.snapshot?.files[0]?.staged).toBe('modified');
    expect(picked()).toEqual([]);
    expect(fake.callsOf('diff_file').length).toBeGreaterThanOrEqual(2);
  });

  it("Discard lines: confirm-dialog with the number of lines, nothing sent on cancel, discard_hunk { lines } on confirm", async () => {
    fake.on('discard_hunk', () => snapshot([]));
    mount({ kind: 'unstaged' });
    await waitFor(() => expect(lines()).toHaveLength(7));
    await userEvent.click(gutter(1));
    await userEvent.click(gutter(3));
    await userEvent.click(within(header()).getByTestId('diff-lines-discard-btn'));
    const dlg = await screen.findByTestId('confirm-dialog');
    expect(dlg).toHaveAttribute('data-action', 'discard');
    expect(dlg).toHaveTextContent('Discard the 2 selected lines in "mod.txt"?');
    await userEvent.click(tid('confirm-dialog-cancel-btn'));
    await whenIdle();
    expect(fake.callsOf('discard_hunk')).toHaveLength(0);
    expect(picked()).toEqual([1, 3]);
    await userEvent.click(within(header()).getByTestId('diff-lines-discard-btn'));
    await userEvent.click(await screen.findByTestId('confirm-dialog-confirm-btn'));
    await whenIdle();
    expect(fake.callsOf('discard_hunk')[0]!.args).toMatchObject({ hunkIndex: 0, lines: [1, 3] });
  });

  it("staged diff: only Unstage lines; unstage_hunk { lines }", async () => {
    fake.on('unstage_hunk', () => snapshot([]));
    mount({ kind: 'staged' });
    await waitFor(() => expect(lines()).toHaveLength(7));
    await userEvent.click(gutter(6));
    expect(within(header()).queryByTestId('diff-lines-stage-btn')).toBeNull();
    expect(within(header()).queryByTestId('diff-lines-discard-btn')).toBeNull();
    await userEvent.click(within(header()).getByTestId('diff-lines-unstage-btn'));
    await whenIdle();
    expect(fake.callsOf('unstage_hunk')[0]!.args).toMatchObject({ hunkIndex: 0, lines: [6] });
  });

  it("keyboard: Shift+ArrowDown starts and extends the selection, `s` stages it, Escape drops it", async () => {
    fake.on('stage_hunk', () => snapshot([]));
    mount({ kind: 'unstaged' });
    await waitFor(() => expect(lines()).toHaveLength(7));
    await userEvent.click(lines()[1]!); // focuses the hunk
    await userEvent.keyboard('{Shift>}{ArrowDown}{ArrowDown}{/Shift}');
    expect(picked()).toEqual([1, 2]);
    await userEvent.keyboard('{Escape}');
    expect(picked()).toEqual([]);
    expect(tid('diff-lines-status')).toHaveTextContent('');
    await userEvent.keyboard('{Shift>}{ArrowUp}{/Shift}');
    expect(picked()).toEqual([6]);
    await userEvent.keyboard('{Shift>}{ArrowUp}{ArrowUp}{/Shift}');
    expect(picked()).toEqual([3, 4, 6]);
    await userEvent.keyboard('s');
    await whenIdle();
    expect(fake.callsOf('stage_hunk')).toHaveLength(1);
    expect(fake.callsOf('stage_hunk')[0]!.args).toMatchObject({ hunkIndex: 0, lines: [3, 4, 6] });
  });

  it("keyboard: `u` unstages the selected lines of a staged diff", async () => {
    fake.on('unstage_hunk', () => snapshot([]));
    mount({ kind: 'staged' });
    await waitFor(() => expect(lines()).toHaveLength(7));
    await userEvent.click(gutter(1));
    await userEvent.keyboard('u');
    await whenIdle();
    expect(fake.callsOf('unstage_hunk')[0]!.args).toMatchObject({ lines: [1] });
  });

  it("keyboard: Delete discards the selected lines after confirmation", async () => {
    fake.on('discard_hunk', () => snapshot([]));
    mount({ kind: 'unstaged' });
    await waitFor(() => expect(lines()).toHaveLength(7));
    await userEvent.click(gutter(2));
    await userEvent.keyboard('{Delete}');
    await userEvent.click(await screen.findByTestId('confirm-dialog-confirm-btn'));
    await whenIdle();
    expect(fake.callsOf('discard_hunk')[0]!.args).toMatchObject({ lines: [2] });
  });

  it("without selection the keys still act on the focused hunk as a whole", async () => {
    fake.on('stage_hunk', () => snapshot([]));
    mount({ kind: 'unstaged' });
    await waitFor(() => expect(lines()).toHaveLength(7));
    await userEvent.click(lines()[4]!);
    await userEvent.keyboard('s');
    await whenIdle();
    expect(fake.callsOf('stage_hunk')[0]!.args).not.toHaveProperty('lines');
  });

  it("a diff that changed under the selection drops it (the indexes would point to other lines)", async () => {
    mount({ kind: 'unstaged' });
    await waitFor(() => expect(lines()).toHaveLength(7));
    await userEvent.click(gutter(2));
    expect(picked()).toEqual([2]);
    fake.on('diff_file', () => fileDiff({ hash: 'h-other', hunks: [hunk([['ctx', 'a', 1, 1], ['add', 'z', null, 2], ['add', 'y', null, 3]])] }));
    fake.emit('repo:changed', { repoId: 1, kinds: ['worktree'] });
    await waitFor(() => expect(lines()).toHaveLength(3));
    expect(picked()).toEqual([]);
    expect(screen.queryByTestId('diff-lines-count')).toBeNull();
  });

  it("no selection on a diff that cannot be staged by lines", async () => {
    fake.on('diff_file', () => fileDiff({ hunks: BLOCK.hunks }));
    mount({ kind: 'commit', oid: 'a'.repeat(40), parent: 1 });
    await waitFor(() => expect(lines()).toHaveLength(7));
    await userEvent.click(gutter(1));
    expect(picked()).toEqual([]);
    expect(screen.queryByTestId('diff-lines-count')).toBeNull();
  });
});

describe('conflits (RBC-01, RBC-02)', () => {
  const MARKERS = fileDiff({
    path: 'conflict.txt',
    hunks: [hunk([['ctx', "before", 1, 1], ['ctx', '<<<<<<< HEAD', 2, 2], ['ctx', 'ligne main', 3, 3], ['ctx', '=======', 4, 4], ['ctx', 'ligne feature', 5, 5], ['ctx', '>>>>>>> feature', 6, 6]])],
  });

  it("Markers highlighted (diff-conflict-marker), banner, no button of hunk", async () => {
    setup({ diff_file: () => MARKERS }, [file('conflict.txt', { conflict: 'both-modified' })]);
    op.setState(opState({ kind: 'rebase', conflictedPaths: ['conflict.txt'] }));
    mount({ kind: 'conflict', view: 'markers' }, 'conflict.txt');
    await waitFor(() => expect(lines()).toHaveLength(6));
    expect(screen.getAllByTestId('diff-conflict-marker')).toHaveLength(3);
    expect(tid('diff-conflict-banner')).toHaveTextContent("File in conflict — resolve it in your editor, then mark it as resolved, or take one side.");
    expect(screen.queryAllByTestId('diff-hunk-stage-btn')).toHaveLength(0);
    expect(tid('diff-viewer')).toHaveAttribute('data-source', 'conflict');
  });

  it("Marketers tabs / bear / their; change tab charging with the right view", async () => {
    fake = setup({ diff_file: () => MARKERS }, [file('conflict.txt', { conflict: 'both-modified' })]);
    op.setState(opState({ kind: 'rebase', conflictedPaths: ['conflict.txt'] }));
    mount({ kind: 'conflict', view: 'markers' }, 'conflict.txt');
    await waitFor(() => expect(lines()).toHaveLength(6));
    expect(tid('diff-conflict-tab-markers')).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(tid('diff-conflict-tab-theirs'));
    await whenIdle();
    expect(fake.callsOf('diff_file').at(-1)!.args).toMatchObject({ source: { kind: 'conflict', view: 'theirs' } });
    expect(tid('diff-conflict-tab-theirs')).toHaveAttribute('aria-selected', 'true');
    expect(tid('diff-conflict-tab-theirs')).toHaveTextContent("Your commit");
    expect(tid('diff-conflict-tab-ours')).toHaveTextContent('Base (onto)');
  });

  it("deleted-by-us: only the tab on the existing side (theirs) plus marketers", async () => {
    setup({ diff_file: () => fileDiff({ path: 'gone.txt' }) }, [file('gone.txt', { conflict: 'deleted-by-us' })]);
    op.setState(opState({ kind: 'rebase', conflictedPaths: ['gone.txt'] }));
    mount({ kind: 'conflict', view: 'markers' }, 'gone.txt');
    await waitFor(() => expect(screen.queryByTestId('diff-loading')).toBeNull());
    expect(screen.queryByTestId('diff-conflict-tab-ours')).toBeNull();
    expect(tid('diff-conflict-tab-theirs')).toBeInTheDocument();
  });

  describe('"Take ours / theirs" (RSV-01)', () => {
    const open = (path: string) => ui.openCenter('diff', { path, source: { kind: 'conflict', view: 'markers' } });

    it('two buttons named after the sides of the operation; a click sends resolve_paths and closes the diff', async () => {
      fake = setup({ diff_file: () => MARKERS, resolve_paths: () => snapshot([]) }, [file('conflict.txt', { conflict: 'both-modified' })]);
      op.setState(opState({ kind: 'rebase', conflictedPaths: ['conflict.txt'] }));
      open('conflict.txt');
      mount({ kind: 'conflict', view: 'markers' }, 'conflict.txt');
      await waitFor(() => expect(lines()).toHaveLength(6));
      expect(tid('diff-conflict-take-ours-btn')).toHaveTextContent('Take ours: Base (onto)');
      expect(tid('diff-conflict-take-theirs-btn')).toHaveTextContent('Take theirs: Your commit');
      expect(tid('diff-conflict-take-ours-btn')).toHaveAttribute('data-outcome', 'keep');
      expect(tid('diff-conflict-resolve')).toHaveAttribute('role', 'group');

      await userEvent.click(tid('diff-conflict-take-theirs-btn'));
      await whenIdle();
      expect(fake.callsOf('resolve_paths')).toHaveLength(1);
      expect(fake.callsOf('resolve_paths')[0]!.args).toEqual({ repoId: 1, paths: ['conflict.txt'], side: 'theirs' });
      expect(status.files).toEqual([]);
      expect(ui.centerView.id).toBe('graph');
    });

    it('a merge names HEAD and the incoming branch', async () => {
      setup({ diff_file: () => MARKERS }, [file('conflict.txt', { conflict: 'both-modified' })]);
      op.setState(opState({ kind: 'merge', incoming: 'refs/heads/feature', conflictedPaths: ['conflict.txt'] }));
      mount({ kind: 'conflict', view: 'markers' }, 'conflict.txt');
      await waitFor(() => expect(lines()).toHaveLength(6));
      expect(tid('diff-conflict-take-ours-btn')).toHaveTextContent('Take ours: HEAD');
      expect(tid('diff-conflict-take-theirs-btn')).toHaveTextContent('Take theirs: feature');
    });

    it('the side that deleted the file says so: the button deletes it', async () => {
      setup({ diff_file: () => fileDiff({ path: 'gone.txt' }) }, [file('gone.txt', { conflict: 'deleted-by-us' })]);
      op.setState(opState({ kind: 'rebase', conflictedPaths: ['gone.txt'] }));
      mount({ kind: 'conflict', view: 'markers' }, 'gone.txt');
      await waitFor(() => expect(screen.queryByTestId('diff-loading')).toBeNull());
      expect(tid('diff-conflict-take-ours-btn')).toHaveAttribute('data-outcome', 'delete');
      expect(tid('diff-conflict-take-ours-btn')).toHaveAttribute('title', 'Resolve by deleting the file: Base (onto) deleted it');
      expect(tid('diff-conflict-take-theirs-btn')).toHaveAttribute('data-outcome', 'keep');
    });

    it('no buttons when both sides deleted the file, for a submodule or a non UTF-8 path', async () => {
      for (const f of [file('gone.txt', { conflict: 'both-deleted' }), file('lib', { conflict: 'both-modified', submodule: true }), file('bad.txt', { conflict: 'both-modified', nonUtf8: true })]) {
        setup({ diff_file: () => fileDiff({ path: f.path }) }, [f]);
        op.setState(opState({ kind: 'merge', conflictedPaths: [f.path] }));
        const { unmount } = mount({ kind: 'conflict', view: 'markers' }, f.path);
        await waitFor(() => expect(screen.queryByTestId('diff-loading')).toBeNull());
        expect(screen.queryByTestId('diff-conflict-resolve'), f.path).toBeNull();
        unmount();
      }
    });

    it('not on the other diffs; disabled while a write is running', async () => {
      setup({ diff_file: () => MOD }, [file('mod.txt', { unstaged: 'modified' })]);
      mount({ kind: 'unstaged' });
      await waitFor(() => expect(lines()).toHaveLength(8));
      expect(screen.queryByTestId('diff-conflict-resolve')).toBeNull();
    });

    it('is disabled while another write is running', async () => {
      setup({ diff_file: () => MARKERS }, [file('conflict.txt', { conflict: 'both-modified' })]);
      op.setState(opState({ kind: 'merge', conflictedPaths: ['conflict.txt'] }));
      mount({ kind: 'conflict', view: 'markers' }, 'conflict.txt');
      await waitFor(() => expect(lines()).toHaveLength(6));
      const end = op.begin('Fetch', null);
      await waitFor(() => expect(tid('diff-conflict-take-ours-btn')).toBeDisabled());
      expect(tid('diff-conflict-take-theirs-btn')).toBeDisabled();
      end();
      await waitFor(() => expect(tid('diff-conflict-take-ours-btn')).toBeEnabled());
    });
  });
});

describe("refreshment (B10)", () => {
  it('repo:changed { worktree } relance diff_file ; un diff identique ne redessine rien', async () => {
    mount({ kind: 'unstaged' });
    await waitFor(() => expect(lines()).toHaveLength(8));
    const first = lines()[0];
    const before = fake.callsOf('diff_file').length;
    fake.emit('repo:changed', { repoId: 1, kinds: ['worktree'] });
    await whenIdle();
    await waitFor(() => expect(fake.callsOf('diff_file').length).toBe(before + 1));
    expect(lines()[0]).toBe(first); // same hash: DOM unchanged

    fake.on('diff_file', () => fileDiff({ hash: 'h2', hunks: [hunk([['add', 'externe', null, 1]])] }));
    fake.emit('repo:changed', { repoId: 1, kinds: ['worktree'] });
    await waitFor(() => expect(lines()).toHaveLength(1));
  });

  it("watcher gradient: a new status rereads the displayed diff (no repo:changed will come)", async () => {
    mount({ kind: 'unstaged' });
    await waitFor(() => expect(lines()).toHaveLength(8));
    const before = fake.callsOf('diff_file').length;
    status.apply(snapshot([file('mod.txt', { unstaged: 'modified' })], { watcherDegraded: false }));
    await whenIdle();
    expect(fake.callsOf('diff_file')).toHaveLength(before); // watcher healthy: only repo:changed reread diff
    status.apply(snapshot([file('mod.txt', { unstaged: 'modified' })], { watcherDegraded: true }));
    await waitFor(() => expect(fake.callsOf('diff_file').length).toBe(before + 1));
  });

  it("a diff commit is immutable: no reload on repo:changed", async () => {
    mount({ kind: 'commit', oid: 'a'.repeat(40), parent: null });
    await waitFor(() => expect(lines()).toHaveLength(8));
    const before = fake.callsOf('diff_file').length;
    fake.emit('repo:changed', { repoId: 1, kinds: ['worktree', 'index', 'head'] });
    await whenIdle();
    expect(fake.callsOf('diff_file')).toHaveLength(before);
    expect(tid('diff-viewer')).toHaveAttribute('data-source', 'commit');
  });

  it("loading error: message and \"Retry\"", async () => {
    fake = setup({}, [file('mod.txt', { unstaged: 'modified' })]);
    fake.reject('diff_file', { code: 'GIT_FAILED', message: 'boom', details: {} });
    fake.on('diff_file', () => MOD);
    mount({ kind: 'unstaged' });
    expect(await screen.findByTestId('diff-error')).toBeInTheDocument();
    await userEvent.click(within(tid('diff-error')).getByRole('button'));
    await waitFor(() => expect(lines()).toHaveLength(8));
  });
});

describe('virtualisation (02 §4)', () => {
  it("20,000 lines: only one window is in the DOM", async () => {
    const big = hunk(Array.from({ length: 20_000 }, (_, i) => ['add', `ligne ${i}`, null, i + 1] as const), '@@ -0,0 +1,20000 @@');
    fake.on('diff_file', () => fileDiff({ hash: 'big', stats: { added: 20_000, removed: 0 }, hunks: [big] }));
    render(DiffViewer, { props: { path: 'big.txt', source: { kind: 'unstaged' } } });
    await waitFor(() => expect(lines().length).toBeGreaterThan(10));
    expect(lines().length).toBeLessThan(120);
    expect(document.querySelector('[data-virtual="true"]')).not.toBeNull();
  });

  it("under 2 000 lines: everything is done", async () => {
    const h = hunk(Array.from({ length: 1500 }, (_, i) => ['add', `l${i}`, null, i + 1] as const));
    fake.on('diff_file', () => fileDiff({ hash: 'mid', hunks: [h] }));
    render(DiffViewer, { props: { path: 'mid.txt', source: { kind: 'unstaged' } } });
    await waitFor(() => expect(lines()).toHaveLength(1500));
  });
});

describe('context lines and intra-line highlighting (DIFF-05)', () => {
  const REPLACED = fileDiff({
    hash: 'h-ctx3',
    stats: { added: 1, removed: 1 },
    hunks: [hunk([['ctx', 'a', 1, 1], ['del', 'const total = price * qty;', 2, null], ['add', 'const total = price * quantity;', null, 2], ['ctx', 'b', 3, 3]])],
  });
  const marked = () => screen.queryAllByTestId('diff-intraline').map((e) => [e.closest('[data-testid="diff-line"]')?.getAttribute('data-kind'), e.textContent]);
  const select = () => screen.getByTestId<HTMLSelectElement>('diff-context-select');

  beforeEach(() => {
    app.load({});
    fake = setup({ diff_file: () => REPLACED, stage_hunk: () => snapshot([file('mod.txt', { staged: 'modified' })]) }, [file('mod.txt', { unstaged: 'modified' })]);
  });

  it("marks the changed word on both sides of a replaced line, and none on the context", async () => {
    mount({ kind: 'unstaged' });
    await waitFor(() => expect(lines()).toHaveLength(4));
    expect(marked()).toEqual([['del', 'qty'], ['add', 'quantity']]);
    // The line text is whole: marking splits it into pieces without changing what it reads.
    expect(lines()[1]).toHaveTextContent('const total = price * qty;');
    expect(lines()[2]).toHaveTextContent('const total = price * quantity;');
  });

  it("leaves a lone addition or removal unmarked", async () => {
    fake.on('diff_file', () => fileDiff({ hunks: [hunk([['ctx', 'a', 1, 1], ['add', 'brand new', null, 2], ['del', 'gone', 2, null]])] }));
    mount({ kind: 'unstaged' });
    await waitFor(() => expect(lines()).toHaveLength(3));
    expect(marked()).toEqual([]);
  });

  it("asks for the context of the setting (three by default) and offers the choices in the header", async () => {
    mount({ kind: 'unstaged' });
    await waitFor(() => expect(lines()).toHaveLength(4));
    expect(fake.callsOf('diff_file')[0]!.args).toMatchObject({ contextLines: 3 });
    expect(select().value).toBe('3');
    expect([...select().options].map((o) => [o.value, o.textContent])).toEqual([['1', '1 line'], ['3', '3 lines'], ['5', '5 lines'], ['10', '10 lines'], ['25', '25 lines']]);
    expect(screen.getByLabelText('Context')).toBe(select());
    expect(tid('diff-context-status')).toHaveTextContent('Showing 3 lines of context');
  });

  it("uses the saved context from the first request", async () => {
    app.load({ 'diff.contextLines': 10 });
    mount({ kind: 'unstaged' });
    await waitFor(() => expect(lines()).toHaveLength(4));
    expect(fake.callsOf('diff_file')[0]!.args).toMatchObject({ contextLines: 10 });
    expect(select().value).toBe('10');
  });

  it("changing the header's select saves the setting and rereads the diff with it", async () => {
    mount({ kind: 'unstaged' });
    await waitFor(() => expect(lines()).toHaveLength(4));
    fake.on('diff_file', (a) => fileDiff({ hash: `h-ctx${String(a.contextLines)}`, hunks: REPLACED.hunks }));
    await userEvent.selectOptions(select(), '10');
    expect(app.get('diff.contextLines')).toBe(10);
    await waitFor(() => expect(fake.callsOf('diff_file').at(-1)!.args).toMatchObject({ contextLines: 10 }));
    await whenIdle();
    expect(fake.callsOf('settings_set').map((c) => c.args)).toEqual([{ key: 'diff.contextLines', value: 10 }]);
    expect(tid('diff-context-status')).toHaveTextContent('Showing 10 lines of context');
  });

  it("a change of the setting from elsewhere (Settings, palette) rereads the open diff too", async () => {
    mount({ kind: 'unstaged' });
    await waitFor(() => expect(lines()).toHaveLength(4));
    const before = fake.callsOf('diff_file').length;
    void app.set('diff.contextLines', 5);
    await waitFor(() => expect(fake.callsOf('diff_file')).toHaveLength(before + 1));
    expect(fake.callsOf('diff_file').at(-1)!.args).toMatchObject({ contextLines: 5 });
    expect(select().value).toBe('5');
    await whenIdle();
  });

  it("an unchanged setting rereads nothing", async () => {
    mount({ kind: 'unstaged' });
    await waitFor(() => expect(lines()).toHaveLength(4));
    const before = fake.callsOf('diff_file').length;
    void app.set('diff.contextLines', 3);
    await whenIdle();
    expect(fake.callsOf('diff_file')).toHaveLength(before);
  });

  it("hunk actions name the context the diff on screen was read with, even if the setting has moved on since", async () => {
    app.load({ 'diff.contextLines': 5 });
    mount({ kind: 'unstaged' });
    await waitFor(() => expect(lines()).toHaveLength(4));
    // The next read is slow: until it arrives the screen still shows the 5-line diff.
    const releases: (() => void)[] = [];
    fake.on('diff_file', () => new Promise((resolve) => { releases.push(() => resolve(fileDiff({ hash: 'h-ctx25', hunks: REPLACED.hunks }))); }));
    void app.set('diff.contextLines', 25);
    await waitFor(() => expect(fake.callsOf('diff_file')).toHaveLength(2));
    await userEvent.click(tid('diff-hunk-stage-btn'));
    await waitFor(() => expect(fake.callsOf('stage_hunk')).toHaveLength(1));
    // The hash is that of the diff on screen, so the context named with it is the one that diff was read with.
    expect(fake.callsOf('stage_hunk')[0]!.args).toMatchObject({ diffHash: 'h-ctx3', hunkIndex: 0, contextLines: 5 });
    releases.forEach((release) => release());
    await whenIdle();
  });

  it("another context size forgets the focused hunk: its number may name another hunk, or none, in the new diff", async () => {
    fake.on('diff_file', (a) => (a.contextLines === 3 ? MOD : fileDiff({ hash: 'h-ctx25', hunks: REPLACED.hunks })));
    mount({ kind: 'unstaged' });
    await waitFor(() => expect(lines()).toHaveLength(8));
    await userEvent.click(screen.getAllByTestId('diff-hunk-header')[2]!);
    await waitFor(() => expect(screen.getAllByTestId('diff-hunk-header')[2]).toHaveClass('focused'));

    // More context joins the three hunks into one: `s` stages that one (number 0), not the number 2 that was focused.
    await userEvent.selectOptions(select(), '25');
    await waitFor(() => expect(lines()).toHaveLength(4));
    expect(screen.getAllByTestId('diff-hunk-header')).toHaveLength(1);
    expect(screen.getByTestId('diff-hunk-header')).not.toHaveClass('focused');
    tid('diff-viewer').querySelector<HTMLElement>('[data-zone-focus]')!.focus();
    await userEvent.keyboard('s');
    await waitFor(() => expect(fake.callsOf('stage_hunk')).toHaveLength(1));
    expect(fake.callsOf('stage_hunk')[0]!.args).toMatchObject({ diffHash: 'h-ctx25', hunkIndex: 0, contextLines: 25 });
    await whenIdle();
  });

  it("has no context select on placeholders, nor on a conflict file shown as is", async () => {
    fake.on('diff_file', () => fileDiff({ binary: true, oldSize: 1, newSize: 2 }));
    const view = mount({ kind: 'unstaged' });
    await screen.findByTestId('diff-binary-placeholder');
    expect(screen.queryByTestId('diff-context-select')).toBeNull();
    view.unmount();
    fake.on('diff_file', () => fileDiff({ hunks: [hunk([['ctx', '<<<<<<< HEAD', 1, 1], ['ctx', 'x', 2, 2]])] }));
    setup({ diff_file: () => fileDiff({ hunks: [hunk([['ctx', '<<<<<<< HEAD', 1, 1], ['ctx', 'x', 2, 2]])] }) }, [file('conflict.txt', { conflict: 'both-modified' })]);
    mount({ kind: 'conflict', view: 'markers' }, 'conflict.txt');
    await waitFor(() => expect(lines()).toHaveLength(2));
    expect(screen.queryByTestId('diff-context-select')).toBeNull();
  });

  it("keys typed in the context select do not reach the hunk shortcuts", async () => {
    mount({ kind: 'unstaged' });
    await waitFor(() => expect(lines()).toHaveLength(4));
    await userEvent.click(lines()[1]!); // focuses the only hunk
    select().focus();
    await userEvent.keyboard('s');
    await whenIdle();
    expect(fake.callsOf('stage_hunk')).toHaveLength(0);
    // Back in the diff, the shortcut works.
    tid('diff-viewer').querySelector<HTMLElement>('[data-zone-focus]')!.focus();
    await userEvent.keyboard('s');
    await waitFor(() => expect(fake.callsOf('stage_hunk')).toHaveLength(1));
    await whenIdle();
  });

  it("the palette steps the context while a diff is open, and lists a step only when it can act", async () => {
    const ids = () => availableCommands().map((e) => e.id).filter((id) => id.startsWith('diff.context'));
    expect(ids()).toEqual([]); // no diff open
    expect(await runAction('diff.context-more')).toBe(false);
    expect(app.get('diff.contextLines')).toBe(3);

    ui.openCenter('diff', { path: 'mod.txt', source: { kind: 'unstaged' } });
    expect(ids()).toEqual(['diff.context-more', 'diff.context-less']);
    expect(availableCommands().find((e) => e.id === 'diff.context-more')!.label).toBe('Diff: show more context');
    for (const expected of [5, 10, 25]) {
      expect(await runAction('diff.context-more')).toBe(true);
      expect(app.get('diff.contextLines')).toBe(expected);
    }
    expect(ids()).toEqual(['diff.context-less']); // the most context is shown already
    expect(await runAction('diff.context-more')).toBe(false);
    for (const expected of [10, 5, 3, 1]) {
      expect(await runAction('diff.context-less')).toBe(true);
      expect(app.get('diff.contextLines')).toBe(expected);
    }
    expect(ids()).toEqual(['diff.context-more']);
    await whenIdle();
  });

  it("the open diff follows the palette and says so to a screen reader", async () => {
    ui.openCenter('diff', { path: 'mod.txt', source: { kind: 'unstaged' } });
    mount({ kind: 'unstaged' });
    await waitFor(() => expect(lines()).toHaveLength(4));
    await runAction('diff.context-more');
    await waitFor(() => expect(fake.callsOf('diff_file').at(-1)!.args).toMatchObject({ contextLines: 5 }));
    expect(select().value).toBe('5');
    expect(tid('diff-context-status')).toHaveTextContent('Showing 5 lines of context');
    await whenIdle();
  });
});
