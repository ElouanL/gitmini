// `diff-viewer` (05): lines and numbers, placeholders, hunks, diff expired, conflicts, refreshment, virtualization.
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { whenIdle } from '$lib/activity';
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
    expect(fake.callsOf('diff_file')[0]!.args).toEqual({ repoId: 1, path: 'mod.txt', source: { kind: 'unstaged' } });
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
    expect(fake.callsOf('stage_hunk')[0]!.args).toEqual({ repoId: 1, path: 'mod.txt', diffHash: 'h-mod', hunkIndex: 1 });
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
    expect(tid('diff-conflict-banner')).toHaveTextContent("File in conflict — resolve it in your editor, then mark it as resolved.");
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
