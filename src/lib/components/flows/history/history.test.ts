// File history and blame: the center view (list, paging, follow, selection, diff, blame tab), the blame view alone, the entries
// that open them (file menus, diff header, palette) and the lazy registration.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { whenIdle } from '$lib/activity';
import { actionContext, actionDisabledReason, getAction, runAction } from '$lib/actions/registry';
import { availableCommands } from '$lib/actions/palette';
import CenterArea from '$lib/components/layout/CenterArea.svelte';
import FileList from '$lib/components/commit-details/FileList.svelte';
import ContextMenu from '$lib/components/menu/ContextMenu.svelte';
import { resolveMenu } from '$lib/menus/registry';
import type { MenuTarget } from '$lib/menus/types';
import type { AppError, BlameCommit, BlameHunk, DiffSource, FileBlame, FileChange, FileLogEntry, FileLogPage, FileStatus } from '$lib/ipc/types';
import { graph } from '$lib/stores/graph.svelte';
import { ui } from '$lib/stores/ui.svelte';
import { resetAll } from '$lib/test/reset';
import type { FakeTransport, Handler } from '$lib/test/fake-transport';
import '$lib/register-core';
import '../../wt/register';
import './register';
import DiffViewer from '../../diff/DiffViewer.svelte';
import { file, fileDiff, hunk, setup } from '../../wt/__tests__/helpers';
import BlameView from './BlameView.svelte';
import FileHistoryView from './FileHistoryView.svelte';

const tid = (id: string) => screen.getByTestId(id);
const maybe = (id: string) => screen.queryByTestId(id);
const items = () => screen.queryAllByTestId('file-history-item');
const oidsOf = () => items().map((e) => e.getAttribute('data-oid'));
const NOW = Math.floor(Date.now() / 1000);

const long = (c: string): string => c.repeat(40);
const [C1, C2, C3, C4] = ['1', '2', '3', '4'].map(long) as [string, string, string, string];

const change = (path: string, over: Partial<FileChange> = {}): FileChange => ({ path, oldPath: null, change: 'modified', additions: 2, deletions: 1, binary: false, submodule: null, ...over });
function entry(oid: string, summary: string, over: Omit<Partial<FileLogEntry>, 'file'> & { file?: Partial<FileChange> } = {}): FileLogEntry {
  const { file: f, ...rest } = over;
  return {
    oid, parents: ['f'.repeat(40)], summary, author: { name: 'Alice Martin', email: 'alice@example.org', time: NOW - 3600, offsetMinutes: 0 },
    file: change('docs/manual.txt', f), parent: 1, ...rest,
  };
}

/** Newest first: a modification, the commit that renamed the file, the commit that added it (as `docs/guide.txt`). */
const E3 = entry(C3, 'edit the manual');
const E2 = entry(C2, 'rename the guide', { file: { change: 'renamed', oldPath: 'docs/guide.txt', additions: 1, deletions: 1 } });
const E1 = entry(C1, 'add the guide', { parent: null, parents: [], file: { path: 'docs/guide.txt', change: 'added', additions: 12, deletions: 0 } });
const page = (entries: FileLogEntry[], nextCursor: string | null = null, start: string | null = C4): FileLogPage => ({ start, entries, nextCursor });

const commit = (oid: string, summary: string, over: Partial<BlameCommit> = {}): BlameCommit => ({
  oid, summary, author: { name: 'Bob Durand', email: 'bob@example.org', time: NOW - 86_400, offsetMinutes: 0 }, root: false, ...over,
});
const hunkOf = (start: number, lines: number, c: number, over: Partial<BlameHunk> = {}): BlameHunk => ({ start, lines, commit: c, origStart: start, origPath: null, ...over });
function blameOf(over: Partial<FileBlame> = {}): FileBlame {
  return {
    rev: C3, path: 'docs/manual.txt', binary: false, tooLarge: null,
    lines: ['title', 'intro', 'body', 'end'],
    hunks: [hunkOf(1, 1, 0), hunkOf(2, 2, 1, { origStart: 5, origPath: 'docs/guide.txt' }), hunkOf(4, 1, 0)],
    commits: [commit(C3, 'edit the manual'), commit(C1, 'add the guide', { root: true })],
    ...over,
  };
}

let fake: FakeTransport;
const DIFF = fileDiff({ path: 'docs/manual.txt', hunks: [hunk([['ctx', 'a', 1, 1], ['add', 'b', null, 2]])], stats: { added: 1, removed: 0 } });

function mountView(props: { path?: string; rev?: string | null; mode?: 'changes' | 'blame' } = {}, handlers: Record<string, Handler> = {}) {
  fake = setup({ file_log: () => page([E3, E2, E1]), diff_file: () => DIFF, file_blame: () => blameOf(), ...handlers });
  return render(FileHistoryView, { props: { path: 'docs/manual.txt', ...props } });
}

beforeAll(async () => {
  // The lazy view is loaded once so that no test waits for a transform.
  await import('./FileHistoryView.svelte');
}, 30_000);

beforeEach(() => resetAll({ keepRegistrations: true }));

describe('file-history-view: the list', () => {
  it('lists the commits the backend returns, newest first, and reads the file from HEAD with renames followed', async () => {
    mountView();
    await waitFor(() => expect(items()).toHaveLength(3));
    expect(fake.callsOf('file_log')[0]!.args).toEqual({ repoId: 1, path: 'docs/manual.txt', follow: true });
    expect(oidsOf()).toEqual([C3, C2, C1]);
    expect(items().map((e) => e.getAttribute('data-change'))).toEqual(['modified', 'renamed', 'added']);
    expect(items()[0]).toHaveTextContent('edit the manual');
    expect(items()[0]).toHaveTextContent('Alice Martin');
    expect(items()[0]).toHaveTextContent('+2 −1');
    expect(tid('file-history-count')).toHaveTextContent('3 changes');
    expect(tid('file-history-view')).toHaveAttribute('data-follow', 'true');
    expect(tid('file-history-view')).toHaveAttribute('data-mode', 'changes');
    expect(maybe('file-history-more-btn')).toBeNull();
  });

  it('tells the name the file had in a commit that renamed it or came before', async () => {
    mountView();
    await waitFor(() => expect(items()).toHaveLength(3));
    const note = (i: number) => within(items()[i]!).queryByTestId('file-history-item-note');
    expect(note(0)).toBeNull();
    expect(note(1)).toHaveTextContent('from docs/guide.txt');
    expect(note(2)).toHaveTextContent('as docs/guide.txt');
  });

  it('marks a merge, and shows a binary file without line counts', async () => {
    mountView({}, {
      file_log: () => page([
        entry(C3, 'merge it', { parents: [C1, C2], parent: 2 }),
        entry(C2, 'new logo', { file: { binary: true, additions: null, deletions: null } }),
      ]),
    });
    await waitFor(() => expect(items()).toHaveLength(2));
    expect(within(items()[0]!).getByTestId('file-history-item-merge')).toHaveAttribute('title', expect.stringContaining('parent 2'));
    expect(within(items()[1]!).queryByTestId('file-history-item-merge')).toBeNull();
    expect(items()[1]).toHaveTextContent('binary');
  });

  it('selects the newest commit and shows what it changed beside the list, in the embedded diff viewer', async () => {
    mountView();
    await waitFor(() => expect(items()).toHaveLength(3));
    await waitFor(() => expect(items()[0]).toHaveAttribute('data-selected', 'true'));
    await waitFor(() => expect(fake.callsOf('diff_file')).toHaveLength(1));
    expect(fake.callsOf('diff_file')[0]!.args).toMatchObject({ repoId: 1, path: 'docs/manual.txt', source: { kind: 'commit', oid: C3, parent: null } });
    expect(tid('diff-viewer')).toHaveAttribute('data-source', 'commit');
    // the viewer is embedded: the view owns the close button, and there is no second history button
    expect(maybe('diff-close-btn')).toBeNull();
    expect(maybe('diff-history-btn')).toBeNull();
    expect(tid('file-history-selected')).toHaveAttribute('data-oid', C3);
  });

  it('a click selects another commit: its diff is read under the name the file had in it', async () => {
    mountView();
    await waitFor(() => expect(items()).toHaveLength(3));
    await userEvent.click(within(items()[2]!).getByRole('button', { name: /add the guide/ }));
    await waitFor(() => expect(items()[2]).toHaveAttribute('data-selected', 'true'));
    await waitFor(() => expect(fake.callsOf('diff_file').at(-1)!.args).toMatchObject({ path: 'docs/guide.txt', source: { kind: 'commit', oid: C1, parent: null } }));
    expect(items()[0]).not.toHaveAttribute('data-selected');
  });

  it('a merge is read against the parent the backend diffed it with', async () => {
    mountView({}, { file_log: () => page([entry(C3, 'merge it', { parents: [C1, C2], parent: 2 })]) });
    await waitFor(() => expect(fake.callsOf('diff_file')).toHaveLength(1));
    expect(fake.callsOf('diff_file')[0]!.args).toMatchObject({ source: { kind: 'commit', oid: C3, parent: 2 } });
  });

  it('the list is a roving list: ArrowDown moves the focus, Enter selects', async () => {
    mountView();
    await waitFor(() => expect(items()).toHaveLength(3));
    const mains = items().map((li) => li.querySelector<HTMLButtonElement>('[data-roving]')!);
    mains[0]!.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(mains[1]).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(items()[1]).toHaveAttribute('data-selected', 'true'));
    await userEvent.keyboard('{End}');
    expect(mains[2]).toHaveFocus();
  });

  it('the graph buttons are out of the tab order: ArrowRight reaches one from its commit, ArrowLeft goes back', async () => {
    mountView();
    await waitFor(() => expect(items()).toHaveLength(3));
    const reveals = screen.getAllByTestId('file-history-item-reveal-btn');
    expect(reveals.map((b) => b.getAttribute('tabindex'))).toEqual(['-1', '-1', '-1']);
    const main = items()[1]!.querySelector<HTMLButtonElement>('[data-roving]')!;
    main.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(reveals[1]).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(main).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}'); // nothing to the left of a commit
    expect(main).toHaveFocus();
  });

  it('"Show in graph" closes the view and reveals the commit', async () => {
    mountView();
    const revealer = vi.fn().mockResolvedValue(undefined);
    graph.registerRevealer(revealer);
    ui.openCenter('file-history', { path: 'docs/manual.txt' });
    await waitFor(() => expect(items()).toHaveLength(3));
    const button = within(items()[1]!).getByTestId('file-history-item-reveal-btn');
    expect(button).toHaveAccessibleName(`Show ${C2.slice(0, 7)} in the graph`);
    await userEvent.click(button);
    expect(revealer).toHaveBeenCalledWith(C2);
    expect(ui.centerIsGraph).toBe(true);
  });

  it('the close button returns to the graph', async () => {
    mountView();
    ui.openCenter('file-history', { path: 'docs/manual.txt' });
    await waitFor(() => expect(items()).toHaveLength(3));
    await userEvent.click(tid('file-history-close-btn'));
    expect(ui.centerIsGraph).toBe(true);
  });
});

describe('file-history-view: start, follow and paging', () => {
  it('reads from the given commit, says so, and "From HEAD" starts again from HEAD', async () => {
    mountView({ rev: C2 }, { file_log: (a) => (a.rev === C2 ? page([E2, E1], null, C2) : page([E3, E2, E1])) });
    await waitFor(() => expect(items()).toHaveLength(2));
    expect(fake.callsOf('file_log')[0]!.args).toEqual({ repoId: 1, path: 'docs/manual.txt', follow: true, rev: C2 });
    expect(tid('file-history-rev')).toHaveTextContent(`up to ${C2.slice(0, 7)}`);
    expect(tid('file-history-view')).toHaveAttribute('data-rev', C2);
    // the selected commit is the newest listed
    expect(items()[0]).toHaveAttribute('data-selected', 'true');

    await userEvent.click(tid('file-history-head-btn'));
    await waitFor(() => expect(items()).toHaveLength(3));
    expect(fake.callsOf('file_log').at(-1)!.args).not.toHaveProperty('rev');
    expect(maybe('file-history-rev')).toBeNull();
    expect(maybe('file-history-head-btn')).toBeNull();
    // the commit that was selected is still selected
    expect(items()[1]).toHaveAttribute('data-oid', C2);
    expect(items()[1]).toHaveAttribute('data-selected', 'true');
    expect(tid('file-history-view')).not.toHaveAttribute('data-rev');
  });

  it('"Follow renames" is on; turning it off reads the history again without it', async () => {
    mountView({}, { file_log: (a) => (a.follow === false ? page([E3, entry(C2, 'rename the guide', { file: { change: 'added', additions: 12, deletions: 0 } })]) : page([E3, E2, E1])) });
    await waitFor(() => expect(items()).toHaveLength(3));
    const toggle = tid('file-history-follow-toggle');
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    await waitFor(() => expect(items()).toHaveLength(2));
    expect(fake.callsOf('file_log').at(-1)!.args).toMatchObject({ follow: false });
    expect(items()[1]).toHaveAttribute('data-change', 'added');
    expect(tid('file-history-view')).toHaveAttribute('data-follow', 'false');
    await userEvent.click(toggle);
    await waitFor(() => expect(items()).toHaveLength(3));
    expect(fake.callsOf('file_log').at(-1)!.args).toMatchObject({ follow: true });
  });

  it('"Load more" asks for the next page with the cursor and appends it; the count says "so far" until the end', async () => {
    mountView({}, { file_log: (a) => (a.cursor === 'c1' ? page([E1], null, null) : page([E3, E2], 'c1')) });
    await waitFor(() => expect(items()).toHaveLength(2));
    expect(tid('file-history-count')).toHaveTextContent('2 changes so far');
    await userEvent.click(tid('file-history-more-btn'));
    await waitFor(() => expect(items()).toHaveLength(3));
    expect(fake.callsOf('file_log').at(-1)!.args).toEqual({ repoId: 1, path: 'docs/manual.txt', follow: true, cursor: 'c1' });
    expect(oidsOf()).toEqual([C3, C2, C1]);
    expect(tid('file-history-count')).toHaveTextContent('3 changes');
    expect(maybe('file-history-more-btn')).toBeNull();
  });

  it('a page that found nothing but has a cursor is followed by the next one without asking', async () => {
    let calls = 0;
    mountView({}, {
      file_log: (a) => {
        calls++;
        if (a.cursor === 'c2') return page([E3], null, null);
        if (a.cursor === 'c1') return page([], 'c2', null);
        return page([], 'c1');
      },
    });
    await waitFor(() => expect(items()).toHaveLength(1));
    expect(calls).toBe(3);
    expect(items()[0]).toHaveAttribute('data-selected', 'true');
    expect(maybe('file-history-more-btn')).toBeNull();
    expect(maybe('file-history-empty')).toBeNull();
  });

  it('keeps going with "Load more" too when the next page is empty', async () => {
    mountView({}, {
      file_log: (a) => {
        if (a.cursor === 'c2') return page([E1], null, null);
        if (a.cursor === 'c1') return page([], 'c2', null);
        return page([E3, E2], 'c1');
      },
    });
    await waitFor(() => expect(items()).toHaveLength(2));
    await userEvent.click(tid('file-history-more-btn'));
    await waitFor(() => expect(items()).toHaveLength(3));
    expect(fake.callsOf('file_log').map((c) => c.args.cursor ?? null)).toEqual([null, 'c1', 'c2']);
  });

  it('the same commit met twice is listed once', async () => {
    mountView({}, { file_log: (a) => (a.cursor ? page([E2, E1], null, null) : page([E3, E2], 'c1')) });
    await waitFor(() => expect(items()).toHaveLength(2));
    await userEvent.click(tid('file-history-more-btn'));
    await waitFor(() => expect(items()).toHaveLength(3));
    expect(oidsOf()).toEqual([C3, C2, C1]);
  });

  it('a history that goes on after the first page keeps the selection while more is loaded', async () => {
    mountView({}, { file_log: (a) => (a.cursor ? page([E1], null, null) : page([E3, E2], 'c1')) });
    await waitFor(() => expect(items()).toHaveLength(2));
    await userEvent.click(within(items()[1]!).getByRole('button', { name: /rename the guide/ }));
    await userEvent.click(tid('file-history-more-btn'));
    await waitFor(() => expect(items()).toHaveLength(3));
    expect(items()[1]).toHaveAttribute('data-selected', 'true');
  });
});

describe('file-history-view: states', () => {
  it('a file with no commit says so, and has nothing to select', async () => {
    mountView({}, { file_log: () => page([]) });
    expect(await screen.findByTestId('file-history-empty')).toHaveTextContent('No commit has changed this file yet.');
    expect(tid('file-history-select')).toBeInTheDocument();
    expect(maybe('diff-viewer')).toBeNull();
    expect(fake.callsOf('diff_file')).toHaveLength(0);
  });

  it('an error is a message with a retry, never a toast', async () => {
    mountView();
    await waitFor(() => expect(items()).toHaveLength(3));
    // reload through the follow toggle to hit the rejection
    fake.reject('file_log', { code: 'GIT_FAILED', message: 'boom', details: {} } satisfies AppError);
    await userEvent.click(tid('file-history-follow-toggle'));
    expect(await screen.findByTestId('file-history-error')).toHaveTextContent('Could not read the history of this file.');
    expect(tid('file-history-error')).toHaveTextContent('boom');
    expect(maybe('toast')).toBeNull();
    await userEvent.click(tid('file-history-retry-btn'));
    await waitFor(() => expect(items()).toHaveLength(3));
    expect(maybe('file-history-error')).toBeNull();
  });

  it('a page that fails after the first keeps the list and says why, and the button tries again', async () => {
    mountView({}, { file_log: (a) => (a.cursor ? page([E1], null, null) : page([E3, E2], 'c1')) });
    await waitFor(() => expect(items()).toHaveLength(2));
    fake.reject('file_log', { code: 'GIT_FAILED', message: 'disk trouble', details: {} } satisfies AppError);
    await userEvent.click(tid('file-history-more-btn'));
    expect(await screen.findByTestId('file-history-more-error')).toHaveTextContent('disk trouble');
    expect(items()).toHaveLength(2);
    await userEvent.click(tid('file-history-more-btn'));
    await waitFor(() => expect(items()).toHaveLength(3));
    expect(maybe('file-history-more-error')).toBeNull();
  });
});

describe('file-history-view: live updates', () => {
  it('a new commit on HEAD reads a history that starts at HEAD again, keeping the selection', async () => {
    mountView();
    await waitFor(() => expect(items()).toHaveLength(3));
    await userEvent.click(within(items()[1]!).getByRole('button', { name: /rename the guide/ }));
    expect(fake.callsOf('file_log')).toHaveLength(1);
    fake.emit('repo:changed', { repoId: 1, kinds: ['head'] });
    await waitFor(() => expect(fake.callsOf('file_log')).toHaveLength(2));
    await whenIdle();
    expect(items()[1]).toHaveAttribute('data-selected', 'true');
  });

  it('events of another repository, or about the worktree, leave it alone', async () => {
    mountView();
    await waitFor(() => expect(items()).toHaveLength(3));
    fake.emit('repo:changed', { repoId: 2, kinds: ['head'] });
    fake.emit('repo:changed', { repoId: 1, kinds: ['worktree', 'index'] });
    await whenIdle();
    expect(fake.callsOf('file_log')).toHaveLength(1);
  });

  it('a history up to a given commit is immutable: moving refs do not read it again', async () => {
    mountView({ rev: C2 });
    await waitFor(() => expect(items().length).toBeGreaterThan(0));
    fake.emit('repo:changed', { repoId: 1, kinds: ['head', 'refs'] });
    await whenIdle();
    expect(fake.callsOf('file_log')).toHaveLength(1);
  });
});

describe('file-history-view: blame tab', () => {
  it('the tabs are a tablist with the selected one in the tab order; arrows switch', async () => {
    mountView();
    await waitFor(() => expect(items()).toHaveLength(3));
    expect(screen.getByRole('tablist')).toHaveAccessibleName('File views');
    expect(tid('file-history-tab-changes')).toHaveAttribute('aria-selected', 'true');
    expect(tid('file-history-tab-changes')).toHaveAttribute('tabindex', '0');
    expect(tid('file-history-tab-blame')).toHaveAttribute('tabindex', '-1');
    tid('file-history-tab-changes').focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(tid('file-history-tab-blame')).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(tid('file-history-tab-blame')).toHaveFocus());
    expect(tid('file-history-pane')).toHaveAttribute('data-mode', 'blame');
    await userEvent.keyboard('{ArrowLeft}');
    expect(tid('file-history-tab-changes')).toHaveAttribute('aria-selected', 'true');
  });

  it('blames the file as the selected commit has it, and again when another commit is selected', async () => {
    mountView({ mode: 'blame' });
    await waitFor(() => expect(fake.callsOf('file_blame')).toHaveLength(1));
    expect(fake.callsOf('file_blame')[0]!.args).toEqual({ repoId: 1, path: 'docs/manual.txt', rev: C3 });
    expect(await screen.findByTestId('file-blame')).toHaveAttribute('data-rev', C3);
    expect(fake.callsOf('diff_file')).toHaveLength(0);
    await userEvent.click(within(items()[2]!).getByRole('button', { name: /add the guide/ }));
    await waitFor(() => expect(fake.callsOf('file_blame')).toHaveLength(2));
    expect(fake.callsOf('file_blame')[1]!.args).toEqual({ repoId: 1, path: 'docs/guide.txt', rev: C1 });
  });

  it('picking an annotation selects its commit in the list and shows its change', async () => {
    mountView({ mode: 'blame' });
    const notes = await screen.findAllByTestId('file-blame-annotation');
    // the run of lines 2-3 comes from the commit that added the file, under its old name
    const old = notes.find((n) => n.getAttribute('data-commit') === C1)!;
    await userEvent.click(old);
    await waitFor(() => expect(tid('file-history-view')).toHaveAttribute('data-mode', 'changes'));
    expect(items()[2]).toHaveAttribute('data-selected', 'true');
    await waitFor(() => expect(fake.callsOf('diff_file').at(-1)!.args).toMatchObject({ path: 'docs/guide.txt', source: { kind: 'commit', oid: C1 } }));
  });

  it('picking a commit the list does not hold yet still shows its change, under the file name it had then', async () => {
    const far = long('9');
    mountView({ mode: 'blame' }, {
      file_blame: () => blameOf({ hunks: [hunkOf(1, 4, 0, { origPath: 'old/name.txt' })], commits: [commit(far, 'a long time ago')] }),
    });
    await userEvent.click(await screen.findByTestId('file-blame-annotation'));
    await waitFor(() => expect(tid('file-history-selected')).toHaveAttribute('data-oid', far));
    await waitFor(() => expect(fake.callsOf('diff_file').at(-1)!.args).toMatchObject({ path: 'old/name.txt', source: { kind: 'commit', oid: far, parent: null } }));
    expect(items().some((li) => li.hasAttribute('data-selected'))).toBe(false);
  });

  it('at the commit that deleted the file there is nothing to blame; one click blames the version before', async () => {
    mountView({ mode: 'blame' }, {
      file_log: () => page([entry(C3, 'drop the manual', { file: { change: 'deleted', additions: 0, deletions: 12 } }), E2, E1]),
    });
    expect(await screen.findByTestId('file-blame-deleted')).toHaveTextContent('This commit deleted the file');
    expect(fake.callsOf('file_blame')).toHaveLength(0);
    expect(maybe('file-blame')).toBeNull();
    await userEvent.click(tid('file-blame-prev-btn'));
    await waitFor(() => expect(items()[1]).toHaveAttribute('data-selected', 'true'));
    await waitFor(() => expect(fake.callsOf('file_blame')).toHaveLength(1));
    expect(fake.callsOf('file_blame')[0]!.args).toMatchObject({ rev: C2, path: 'docs/manual.txt' });
  });

  it('a deletion with nothing before it offers no previous version', async () => {
    mountView({ mode: 'blame' }, { file_log: () => page([entry(C3, 'drop it', { file: { change: 'deleted' } })]) });
    await screen.findByTestId('file-blame-deleted');
    expect(maybe('file-blame-prev-btn')).toBeNull();
  });
});

describe('file-history-view: reopened with other props', () => {
  it('follows a new path, start and tab when the view is opened again while it is open', async () => {
    fake = setup({ file_log: (a) => (a.path === 'other.txt' ? page([entry(C4, 'other file', { file: { path: 'other.txt' } })]) : page([E3, E2, E1])), diff_file: () => DIFF, file_blame: () => blameOf() });
    const view = render(FileHistoryView, { props: { path: 'docs/manual.txt' } });
    await waitFor(() => expect(items()).toHaveLength(3));

    await view.rerender({ path: 'docs/manual.txt', mode: 'blame' });
    expect(tid('file-history-view')).toHaveAttribute('data-mode', 'blame');
    await screen.findByTestId('file-blame');
    expect(fake.callsOf('file_log')).toHaveLength(1); // same file: the list stays

    await view.rerender({ path: 'other.txt', rev: C4, mode: 'changes' });
    await waitFor(() => expect(oidsOf()).toEqual([C4]));
    expect(fake.callsOf('file_log').at(-1)!.args).toEqual({ repoId: 1, path: 'other.txt', follow: true, rev: C4 });
    expect(tid('file-history-view')).toHaveAttribute('data-mode', 'changes');
    expect(tid('file-history-view')).toHaveAttribute('data-path', 'other.txt');
  });

  it('is loaded lazily by the center area', async () => {
    fake = setup({ file_log: () => page([E3]), diff_file: () => DIFF });
    render(CenterArea);
    ui.openCenter('file-history', { path: 'docs/manual.txt', rev: null, mode: 'changes' });
    expect(await screen.findByTestId('file-history-view')).toHaveAttribute('data-path', 'docs/manual.txt');
    await waitFor(() => expect(items()).toHaveLength(1));
  });
});

describe('blame-view', () => {
  function mountBlame(blame: () => FileBlame | Promise<FileBlame>, onpick = vi.fn()) {
    fake = setup({ file_blame: blame });
    render(BlameView, { props: { path: 'docs/manual.txt', rev: C3, onpick } });
    return onpick;
  }
  const lineRows = () => screen.queryAllByTestId('file-blame-line');

  it('draws every line with its number, text and the commit behind it; each run is annotated once on its first line', async () => {
    mountBlame(() => blameOf());
    await waitFor(() => expect(lineRows()).toHaveLength(4));
    expect(fake.callsOf('file_blame')[0]!.args).toEqual({ repoId: 1, path: 'docs/manual.txt', rev: C3 });
    expect(lineRows().map((l) => l.getAttribute('data-commit'))).toEqual([C3, C1, C1, C3]);
    expect(lineRows().map((l) => within(l).getByTestId('file-blame-text').textContent)).toEqual(['title', 'intro', 'body', 'end']);
    const notes = screen.getAllByTestId('file-blame-annotation');
    expect(notes.map((n) => n.getAttribute('data-line'))).toEqual(['1', '2', '4']);
    expect(notes[1]).toHaveTextContent(C1.slice(0, 7));
    expect(notes[1]).toHaveTextContent('Bob Durand');
    expect(notes[1]).toHaveTextContent('yesterday');
    expect(notes[1]).toHaveAttribute('title', expect.stringContaining('add the guide'));
    // alternate runs are shaded differently
    expect(lineRows().map((l) => l.getAttribute('data-band'))).toEqual(['0', '1', '1', '0']);
    expect(tid('file-blame')).toHaveAttribute('data-state', 'ready');
  });

  it('picking an annotation hands the commit and the file name it had then to the parent', async () => {
    const onpick = mountBlame(() => blameOf());
    const notes = await screen.findAllByTestId('file-blame-annotation');
    await userEvent.click(notes[1]!);
    expect(onpick).toHaveBeenCalledWith(C1, 'docs/guide.txt');
    await userEvent.click(notes[0]!);
    expect(onpick).toHaveBeenLastCalledWith(C3, 'docs/manual.txt');
  });

  it('the keyboard moves a line cursor, announces the line, and Enter picks its commit', async () => {
    const onpick = mountBlame(() => blameOf());
    await screen.findAllByTestId('file-blame-line');
    const region = screen.getByRole('region', { name: 'Blame of docs/manual.txt' });
    region.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(tid('file-blame-status')).toHaveTextContent(/^Line 1: /);
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(tid('file-blame-status')).toHaveTextContent(`Line 3: ${C1.slice(0, 7)}, Bob Durand, yesterday. add the guide`);
    await userEvent.keyboard('{Enter}');
    expect(onpick).toHaveBeenCalledWith(C1, 'docs/guide.txt');
    await userEvent.keyboard('{End}');
    expect(tid('file-blame-status')).toHaveTextContent(/^Line 4: /);
    await userEvent.keyboard('{ArrowDown}');
    expect(tid('file-blame-status')).toHaveTextContent(/^Line 4: /);
    await userEvent.keyboard('{Home}');
    expect(tid('file-blame-status')).toHaveTextContent(/^Line 1: /);
    expect(lineRows()[0]).toHaveClass('cursor');
    await userEvent.keyboard('{ArrowUp}');
    expect(tid('file-blame-status')).toHaveTextContent(/^Line 1: /);
  });

  it('Enter without a cursor does nothing', async () => {
    const onpick = mountBlame(() => blameOf());
    await screen.findAllByTestId('file-blame-line');
    screen.getByRole('region', { name: 'Blame of docs/manual.txt' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(onpick).not.toHaveBeenCalled();
  });

  it('a long file is virtualized: only the lines in view are drawn', async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`);
    mountBlame(() => blameOf({ lines, hunks: [hunkOf(1, 5000, 0)], commits: [commit(C3, 'everything')] }));
    await waitFor(() => expect(lineRows().length).toBeGreaterThan(0));
    expect(lineRows().length).toBeLessThan(200);
    expect(screen.getByRole('region', { name: 'Blame of docs/manual.txt' })).toHaveAttribute('data-row-count', '5000');
    expect(lineRows()[0]).toHaveAttribute('data-line', '1');
    expect(screen.getAllByTestId('file-blame-annotation')).toHaveLength(1);
  });

  it('a binary file is not blamed; an empty one says so', async () => {
    mountBlame(() => blameOf({ binary: true, lines: [], hunks: [], commits: [] }));
    expect(await screen.findByTestId('file-blame-binary')).toHaveTextContent('binary file');
    expect(maybe('file-blame-line')).toBeNull();
  });

  it('an empty file says so', async () => {
    mountBlame(() => blameOf({ lines: [], hunks: [], commits: [] }));
    expect(await screen.findByTestId('file-blame-empty')).toHaveTextContent('This file is empty.');
  });

  it('a large file waits for a click, which asks again with force; beyond the hard limit there is no button', async () => {
    let forced = 0;
    mountBlame((): FileBlame => {
      const asked = fake.callsOf('file_blame').at(-1)!.args;
      if (asked.force === true) {
        forced++;
        return blameOf();
      }
      return blameOf({ lines: [], hunks: [], commits: [], tooLarge: { bytes: 3 * 1024 * 1024, lines: 45_000, hardLimit: false } });
    });
    const gate = await screen.findByTestId('file-blame-large');
    expect(gate).toHaveTextContent('3.0 MiB and 45,000 lines');
    expect(tid('file-blame')).toHaveAttribute('data-state', 'large');
    await userEvent.click(tid('file-blame-load-btn'));
    await waitFor(() => expect(lineRows()).toHaveLength(4));
    expect(forced).toBe(1);
    expect(fake.callsOf('file_blame').at(-1)!.args).toEqual({ repoId: 1, path: 'docs/manual.txt', rev: C3, force: true });
  });

  it('beyond the hard limit there is nothing to click', async () => {
    mountBlame(() => blameOf({ lines: [], hunks: [], commits: [], tooLarge: { bytes: 20 * 1024 * 1024, lines: 0, hardLimit: true } }));
    const gate = await screen.findByTestId('file-blame-large');
    expect(gate).toHaveAttribute('data-hard-limit', 'true');
    expect(gate).toHaveTextContent('too large to blame');
    expect(maybe('file-blame-load-btn')).toBeNull();
  });

  it('a failure is a message with a retry, not a toast', async () => {
    fake = setup({ file_blame: () => blameOf() });
    fake.reject('file_blame', { code: 'NOT_FOUND', message: 'It is not there.', details: { what: 'path' } } satisfies AppError);
    render(BlameView, { props: { path: 'docs/manual.txt', rev: C3, onpick: vi.fn() } });
    expect(await screen.findByTestId('file-blame-error')).toHaveTextContent('Could not blame this file.');
    expect(tid('file-blame-error')).toHaveTextContent('It is not there.');
    expect(maybe('toast')).toBeNull();
    await userEvent.click(tid('file-blame-retry-btn'));
    await waitFor(() => expect(lineRows()).toHaveLength(4));
  });

  it('another commit blames again from the top, and a late answer for the old one is dropped', async () => {
    let release: (b: FileBlame) => void = () => undefined;
    fake = setup({
      file_blame: (a) =>
        a.rev === C3 ? new Promise<FileBlame>((resolve) => { release = resolve; }) : blameOf({ rev: C1, lines: ['only line'], hunks: [hunkOf(1, 1, 0)], commits: [commit(C1, 'first')] }),
    });
    const view = render(BlameView, { props: { path: 'docs/manual.txt', rev: C3, onpick: vi.fn() } });
    await waitFor(() => expect(fake.callsOf('file_blame')).toHaveLength(1));
    await view.rerender({ path: 'docs/manual.txt', rev: C1, onpick: vi.fn() });
    await waitFor(() => expect(lineRows()).toHaveLength(1));
    release(blameOf());
    await whenIdle();
    expect(lineRows()).toHaveLength(1);
    expect(tid('file-blame')).toHaveAttribute('data-rev', C1);
  });
});

describe('entries that open the history', () => {
  const wtTarget = (f: FileStatus, files?: FileStatus[]): MenuTarget => ({ menu: 'wt-file', file: f, files: files ?? [f] });
  const ids = (target: MenuTarget) => resolveMenu(target).map((i) => i.id);

  beforeEach(() => {
    setup();
  });

  it('a tracked working-tree file offers its history and blame; the menu opens the view from HEAD', async () => {
    const f = file('docs/manual.txt', { unstaged: 'modified' });
    expect(ids(wtTarget(f))).toEqual(expect.arrayContaining(['file-history', 'file-blame']));
    await resolveMenu(wtTarget(f)).find((i) => i.id === 'file-history')!.run();
    expect(ui.centerView).toEqual({ id: 'file-history', props: { path: 'docs/manual.txt', rev: null, mode: 'changes' } });
    await resolveMenu(wtTarget(f)).find((i) => i.id === 'file-blame')!.run();
    expect(ui.centerView.props).toMatchObject({ path: 'docs/manual.txt', mode: 'blame' });
  });

  it('a renamed file is looked up under its old name', async () => {
    const f = file('new.txt', { oldPath: 'old.txt', staged: 'renamed' });
    await resolveMenu(wtTarget(f)).find((i) => i.id === 'file-history')!.run();
    expect(ui.centerView.props).toMatchObject({ path: 'old.txt' });
  });

  it('is not offered for an untracked or newly added file, a selection of several, or a submodule (blame)', () => {
    expect(ids(wtTarget(file('x.txt', { unstaged: 'untracked' })))).not.toContain('file-history');
    expect(ids(wtTarget(file('x.txt', { staged: 'added' })))).not.toContain('file-blame');
    const a = file('a.txt', { unstaged: 'modified' });
    const b = file('b.txt', { unstaged: 'modified' });
    expect(ids(wtTarget(a, [a, b]))).not.toContain('file-history');
    const sub = file('lib', { unstaged: 'modified', submodule: true });
    expect(ids(wtTarget(sub))).toContain('file-history');
    expect(ids(wtTarget(sub))).not.toContain('file-blame');
  });

  it('a file of a commit offers both, up to that commit; a deleted, binary or submodule file offers no blame', async () => {
    const target = (over: Partial<FileChange> = {}): MenuTarget => ({ menu: 'commit-file', oid: C2, file: change('docs/manual.txt', over) });
    expect(ids(target())).toEqual(['file-history', 'file-blame']);
    await resolveMenu(target()).find((i) => i.id === 'file-blame')!.run();
    expect(ui.centerView).toEqual({ id: 'file-history', props: { path: 'docs/manual.txt', rev: C2, mode: 'blame' } });
    await resolveMenu(target()).find((i) => i.id === 'file-history')!.run();
    expect(ui.centerView.props).toMatchObject({ rev: C2, mode: 'changes' });
    expect(ids(target({ change: 'deleted' }))).toEqual(['file-history']);
    expect(ids(target({ binary: true }))).toEqual(['file-history']);
    expect(ids(target({ submodule: true }))).toEqual(['file-history']);
  });

  it('the files of a commit open their menu on right click, when the commit is known', async () => {
    render(ContextMenu);
    const { unmount } = render(FileList, { props: { files: [change('docs/manual.txt')], onopen: vi.fn(), menuOid: C2 } });
    await fireEvent.contextMenu(screen.getByTestId('commit-details-file-item'));
    expect(ui.contextMenu?.target).toMatchObject({ menu: 'commit-file', oid: C2, file: { path: 'docs/manual.txt' } });
    expect(await screen.findByTestId('context-menu-item-file-history')).toHaveTextContent('File History');
    expect(tid('context-menu-item-file-blame')).toHaveTextContent('Blame');
    unmount();
    ui.contextMenu = null;
    render(FileList, { props: { files: [change('docs/manual.txt')], onopen: vi.fn() } });
    await fireEvent.contextMenu(screen.getAllByTestId('commit-details-file-item')[0]!);
    expect(ui.contextMenu).toBeNull();
  });
});

describe('palette actions', () => {
  beforeEach(() => {
    setup();
  });

  const reason = (id: string) => actionDisabledReason(getAction(id)!, actionContext());

  it('are refused without an open file, and not listed in the palette', () => {
    expect(reason('file.history')).toBe('Open a file first');
    expect(reason('file.blame')).toBe('Open a file first');
    const listed = availableCommands().map((c) => c.id);
    expect(listed).not.toContain('file.history');
    expect(listed).not.toContain('file.blame');
  });

  it('act on the file of the open diff; a commit diff starts the history at that commit', async () => {
    ui.openCenter('diff', { path: 'a/b.txt', source: { kind: 'unstaged' } });
    expect(reason('file.history')).toBeNull();
    expect(availableCommands().find((c) => c.id === 'file.history')!.label).toBe('Show history of the open file');
    expect(availableCommands().find((c) => c.id === 'file.blame')!.label).toBe('Blame the open file');
    expect(await runAction('file.history')).toBe(true);
    expect(ui.centerView).toEqual({ id: 'file-history', props: { path: 'a/b.txt', rev: null, mode: 'changes' } });

    ui.openCenter('diff', { path: 'a/b.txt', source: { kind: 'commit', oid: C2, parent: null } });
    await runAction('file.blame');
    expect(ui.centerView).toEqual({ id: 'file-history', props: { path: 'a/b.txt', rev: C2, mode: 'blame' } });
  });

  it('use the name a renamed file has in HEAD, and refuse a file that is not committed yet', async () => {
    setup({}, [file('new.txt', { oldPath: 'old.txt', staged: 'renamed' }), file('fresh.txt', { unstaged: 'untracked' }), file('added.txt', { staged: 'added' })]);
    ui.openCenter('diff', { path: 'new.txt', source: { kind: 'staged' } });
    expect(reason('file.history')).toBeNull();
    await runAction('file.history');
    expect(ui.centerView.props).toEqual({ path: 'old.txt', rev: null, mode: 'changes' });
    await runAction('file.blame');
    expect(ui.centerView.props).toEqual({ path: 'old.txt', rev: null, mode: 'blame' });

    // a commit diff goes by the name in that commit, whatever the working tree says about the file
    ui.openCenter('diff', { path: 'new.txt', source: { kind: 'commit', oid: C2, parent: null } });
    await runAction('file.history');
    expect(ui.centerView.props).toEqual({ path: 'new.txt', rev: C2, mode: 'changes' });

    for (const [path, source] of [['fresh.txt', { kind: 'unstaged' }], ['added.txt', { kind: 'staged' }]] as const) {
      ui.openCenter('diff', { path, source });
      expect(reason('file.history')).toBe('This file is not committed yet');
      expect(reason('file.blame')).toBe('This file is not committed yet');
      const before = ui.centerView;
      expect(await runAction('file.history')).toBe(false);
      expect(ui.centerView).toBe(before);
    }
  });

  it('with the history open, they switch its tab and keep its start', async () => {
    ui.openCenter('file-history', { path: 'a/b.txt', rev: C3, mode: 'changes' });
    expect(reason('file.blame')).toBeNull();
    await runAction('file.blame');
    expect(ui.centerView.props).toEqual({ path: 'a/b.txt', rev: C3, mode: 'blame' });
    await runAction('file.history');
    expect(ui.centerView.props).toEqual({ path: 'a/b.txt', rev: C3, mode: 'changes' });
  });

  it('are refused without a repository', () => {
    resetAll({ keepRegistrations: true });
    expect(reason('file.history')).toBe('No repository open');
  });
});

describe('the diff header', () => {
  function mountDiff(source: DiffSource, over: Partial<ReturnType<typeof fileDiff>> = {}, embedded = false) {
    fake = setup({ diff_file: () => fileDiff({ hunks: [hunk([['ctx', 'a', 1, 1], ['add', 'b', null, 2]])], ...over }) }, [file('mod.txt', { unstaged: 'modified' })]);
    return render(DiffViewer, { props: { path: 'mod.txt', source, ...(embedded ? { embedded: true } : {}) } });
  }

  it('History and Blame open the view on the file, from HEAD for the working tree', async () => {
    mountDiff({ kind: 'unstaged' });
    await userEvent.click(await screen.findByTestId('diff-history-btn'));
    expect(ui.centerView).toEqual({ id: 'file-history', props: { path: 'mod.txt', rev: null, mode: 'changes' } });
    await userEvent.click(tid('diff-blame-btn'));
    expect(ui.centerView.props).toEqual({ path: 'mod.txt', rev: null, mode: 'blame' });
  });

  it('for a commit diff the history is read up to that commit', async () => {
    mountDiff({ kind: 'commit', oid: C2, parent: null });
    await userEvent.click(await screen.findByTestId('diff-history-btn'));
    expect(ui.centerView.props).toEqual({ path: 'mod.txt', rev: C2, mode: 'changes' });
  });

  it('a binary file or a submodule has a history but no blame button', async () => {
    mountDiff({ kind: 'unstaged' }, { binary: true });
    await screen.findByTestId('diff-binary-placeholder');
    expect(tid('diff-history-btn')).toBeInTheDocument();
    expect(maybe('diff-blame-btn')).toBeNull();
  });

  it('a submodule has a history too', async () => {
    mountDiff({ kind: 'unstaged' }, { submodule: { oldOid: C1, newOid: C2, dirty: false } });
    await screen.findByTestId('diff-submodule-placeholder');
    expect(tid('diff-history-btn')).toBeInTheDocument();
    expect(maybe('diff-blame-btn')).toBeNull();
  });

  it('a staged rename is read under the name it has in HEAD, as the file menus do', async () => {
    fake = setup(
      { diff_file: () => fileDiff({ path: 'new.txt', oldPath: 'old.txt', hunks: [hunk([['ctx', 'a', 1, 1], ['add', 'b', null, 2]])] }) },
      [file('new.txt', { oldPath: 'old.txt', staged: 'renamed' })],
    );
    render(DiffViewer, { props: { path: 'new.txt', source: { kind: 'staged' } } });
    await userEvent.click(await screen.findByTestId('diff-history-btn'));
    expect(ui.centerView).toEqual({ id: 'file-history', props: { path: 'old.txt', rev: null, mode: 'changes' } });
    await userEvent.click(tid('diff-blame-btn'));
    expect(ui.centerView.props).toEqual({ path: 'old.txt', rev: null, mode: 'blame' });
  });

  it('a commit diff goes by the name in that commit, even if the status lists the file as renamed', async () => {
    fake = setup(
      { diff_file: () => fileDiff({ path: 'new.txt', hunks: [hunk([['ctx', 'a', 1, 1], ['add', 'b', null, 2]])] }) },
      [file('new.txt', { oldPath: 'old.txt', staged: 'renamed' })],
    );
    render(DiffViewer, { props: { path: 'new.txt', source: { kind: 'commit', oid: C2, parent: null } } });
    await userEvent.click(await screen.findByTestId('diff-history-btn'));
    expect(ui.centerView.props).toEqual({ path: 'new.txt', rev: C2, mode: 'changes' });
  });

  it('a file that is not committed yet has no history to open: neither button', async () => {
    for (const [name, status, source] of [
      ['untracked.txt', { unstaged: 'untracked' }, { kind: 'unstaged' }],
      ['added.txt', { staged: 'added' }, { kind: 'staged' }],
    ] as const) {
      fake = setup({ diff_file: () => fileDiff({ path: name, hunks: [hunk([['add', 'b', null, 1]])] }) }, [file(name, status)]);
      const { unmount } = render(DiffViewer, { props: { path: name, source } });
      await screen.findByTestId('diff-viewer');
      await waitFor(() => expect(maybe('diff-loading')).toBeNull());
      expect(maybe('diff-history-btn')).toBeNull();
      expect(maybe('diff-blame-btn')).toBeNull();
      unmount();
    }
  });

  it('a stash diff offers neither', async () => {
    mountDiff({ kind: 'stash', oid: C2, part: 'worktree' });
    await screen.findByTestId('diff-viewer');
    await waitFor(() => expect(maybe('diff-loading')).toBeNull());
    expect(maybe('diff-history-btn')).toBeNull();
    expect(maybe('diff-blame-btn')).toBeNull();
  });

  it('embedded in the history view, the viewer shows no link back to it and no close button', async () => {
    mountDiff({ kind: 'commit', oid: C2, parent: null }, {}, true);
    await screen.findByTestId('diff-viewer');
    expect(maybe('diff-history-btn')).toBeNull();
    expect(maybe('diff-blame-btn')).toBeNull();
    expect(maybe('diff-close-btn')).toBeNull();
  });
});
