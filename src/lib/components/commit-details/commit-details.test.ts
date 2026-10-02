import { captureStores } from '$lib/stores/context';
// Right panel of a commit (03, GRAPH-02): detail of a commit, file list, diff between two commits, grouped actions.
import { fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { whenIdle } from '$lib/activity';
import { registerAction } from '$lib/actions/registry';
import type { AppError, CommitDetails, FileChange } from '$lib/ipc/types';
import { createFakeTransport, type FakeTransport } from '$lib/test/fake-transport';
import { resetAll } from '$lib/test/reset';
import { graph } from '$lib/stores/graph.svelte';
import { session } from '$lib/stores/session.svelte';
import { ui } from '$lib/stores/ui.svelte';
import { hex, page } from '../graph/test-utils';
import CommitDetailsPanel from './CommitDetailsPanel.svelte';
import { DETAILS_CACHE, DetailsLoader, detailsKey } from './details.svelte';
import MultiCommitPanel from './MultiCommitPanel.svelte';
import { orderPair } from './pair';

const file = (path: string, change: FileChange['change'] = 'modified', over: Partial<FileChange> = {}): FileChange => ({
  path, oldPath: null, change, additions: 3, deletions: 1, binary: false, submodule: null, ...over,
});

const details = (oid: string, over: Partial<CommitDetails> = {}): CommitDetails => ({
  oid, parents: [hex(1)], tree: hex(9000), author: { name: 'Fixture Bot', email: 'bot@fixtures.gitmini', time: 1_700_000_000, offsetMinutes: 0 },
  committer: { name: 'Fixture Bot', email: 'bot@fixtures.gitmini', time: 1_700_000_000, offsetMinutes: 0 }, message: 'commit 7\n\nUn corps de message.',
  files: [file('src/a.ts'), file('b.txt', 'added', { additions: 5, deletions: 0 })], truncated: false, ...over,
});

let fake: FakeTransport;
const settle = async (): Promise<void> => {
  await tick();
  await whenIdle();
  await tick();
};

beforeEach(() => {
  resetAll({ keepRegistrations: true });
  session.begin(1);
  fake = createFakeTransport({ commit_details: (a) => details(String(a.oid)) }).install();
});
afterEach(() => session.end());

describe('DetailsLoader', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debunk 80 ms during fast navigation: only the last request leaves", async () => {
    const loader = new DetailsLoader();
    loader.request(hex(1));
    await vi.advanceTimersByTimeAsync(40);
    loader.request(hex(2));
    await vi.advanceTimersByTimeAsync(40);
    loader.request(hex(3));
    expect(fake.callsOf('commit_details')).toHaveLength(0);
    expect(loader.state.status).toBe('loading');
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.callsOf('commit_details').map((c) => c.args.oid)).toEqual([hex(3)]);
    expect(loader.state).toMatchObject({ status: 'ready', key: detailsKey(hex(3)) });
  });

  it("cache: a commit that has already been read will be displayed immediately without IPC; 32-entry LRU", async () => {
    const loader = new DetailsLoader();
    for (let i = 1; i <= DETAILS_CACHE + 1; i++) {
      loader.request(hex(i));
      await vi.advanceTimersByTimeAsync(100);
    }
    fake.calls.length = 0;
    loader.request(hex(DETAILS_CACHE + 1));
    expect(loader.state.status).toBe('ready'); // synchrone
    loader.request(hex(2));
    expect(loader.state.status).toBe('ready');
    expect(fake.calls).toHaveLength(0);
    loader.request(hex(1)); // the oldest was released
    expect(loader.state.status).toBe('loading');
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.callsOf('commit_details')).toHaveLength(1);
  });

  it("a late response from an outdated request is ignored", async () => {
    let first!: (d: CommitDetails) => void;
    fake.on('commit_details', (a) => (a.oid === hex(1) ? new Promise<CommitDetails>((r) => (first = r)) : details(String(a.oid))));
    const loader = new DetailsLoader();
    loader.request(hex(1));
    await vi.advanceTimersByTimeAsync(100);
    loader.request(hex(2));
    await vi.advanceTimersByTimeAsync(100);
    first(details(hex(1)));
    await vi.advanceTimersByTimeAsync(0);
    expect(loader.state).toMatchObject({ status: 'ready', key: detailsKey(hex(2)) });
  });

  it("against another commit: `against` is part of the key and call", async () => {
    const loader = new DetailsLoader();
    loader.request(hex(5), hex(2));
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.callsOf('commit_details')[0]!.args).toEqual({ repoId: 1, oid: hex(5), against: hex(2) });
    expect(detailsKey(hex(5), hex(2))).not.toBe(detailsKey(hex(5)));
  });

  it("NOT_FOUND { what: \"oid\" }: the commit no longer exists, the caller returns to HEAD; other error: error status + Try again", async () => {
    const gone = vi.fn();
    const loader = new DetailsLoader(gone);
    fake.reject('commit_details', { code: 'NOT_FOUND', message: 'x', details: { what: 'oid' } } satisfies AppError);
    loader.request(hex(8));
    await vi.advanceTimersByTimeAsync(100);
    expect(gone).toHaveBeenCalledWith(hex(8));
    fake.reject('commit_details', { code: 'GIT_FAILED', message: "broken", details: {} } satisfies AppError);
    loader.request(hex(9));
    await vi.advanceTimersByTimeAsync(100);
    expect(loader.state).toMatchObject({ status: 'error' });
    loader.retry();
    await vi.advanceTimersByTimeAsync(100);
    expect(loader.state.status).toBe('ready');
  });

  it("request(null) cancels and returns to idle", () => {
    const loader = new DetailsLoader();
    loader.request(hex(1));
    loader.request(null);
    expect(loader.state.status).toBe('idle');
  });
});

describe('orderPair', () => {
  it("old → recent after the rank of the graph (the smallest row is the most recent)", () => {
    const rows: Record<string, number> = { a: 10, b: 3 };
    expect(orderPair('a', 'b', (o) => rows[o] ?? null)).toEqual({ newer: 'b', older: 'a' });
    expect(orderPair('b', 'a', (o) => rows[o] ?? null)).toEqual({ newer: 'b', older: 'a' });
  });
  it("unknown rank: the 2nd commit selected is assumed to be the most recent", () => {
    expect(orderPair('a', 'b', () => null)).toEqual({ newer: 'b', older: 'a' });
  });
});

describe('commit-details-panel (GRAPH-02)', () => {
  it("displays SHA, author, message, parents and list of files with data-path / data-change", async () => {
    graph.selectCommit(hex(7));
    const { getByTestId, getAllByTestId } = render(CommitDetailsPanel);
    await new Promise((r) => setTimeout(r, 120));
    await settle();
    const panel = getByTestId('commit-details-panel');
    expect(panel.dataset.oid).toBe(hex(7));
    expect(getByTestId('commit-details-sha').textContent).toBe(hex(7));
    expect(getByTestId('commit-details-title').textContent).toBe('commit 7');
    expect(getByTestId('commit-details-message').textContent).toBe('Un corps de message.');
    expect(getByTestId('commit-details-author').textContent).toContain('Fixture Bot');
    expect(getByTestId('commit-details-author').textContent).toContain('bot@fixtures.gitmini');
    const files = getAllByTestId('commit-details-file-item');
    expect(files.map((f) => [f.dataset.path, f.dataset.change])).toEqual([['src/a.ts', 'modified'], ['b.txt', 'added']]);
    expect(getByTestId('commit-details-file-count').textContent).toBe("2 files modified");
    expect(fake.callsOf('commit_details')[0]!.args).toEqual({ repoId: 1, oid: hex(7) });
  });

  it("click on a file opens diff commit in the central view", async () => {
    graph.selectCommit(hex(7));
    const { getAllByTestId } = render(CommitDetailsPanel);
    await new Promise((r) => setTimeout(r, 120));
    await settle();
    await fireEvent.click(getAllByTestId('commit-details-file-item')[1]!);
    expect(ui.centerView).toEqual({ id: 'diff', props: { path: 'b.txt', source: { kind: 'commit', oid: hex(7), parent: null } } });
  });

  it("one merge : commit-details-parent-select chooses the parent (base of the diff, 1-based)", async () => {
    fake.on('commit_details', (a) => details(String(a.oid), { parents: [hex(1), hex(2)], files: a.against ? [file('only-vs-parent2.txt')] : [file('vs-parent1.txt')] }));
    graph.selectCommit(hex(7));
    const { getByTestId, getAllByTestId } = render(CommitDetailsPanel);
    await new Promise((r) => setTimeout(r, 120));
    await settle();
    expect(getAllByTestId('commit-details-file-item').map((f) => f.dataset.path)).toEqual(['vs-parent1.txt']);
    const select = getByTestId('commit-details-parent-select') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['1', '2']);
    await fireEvent.change(select, { target: { value: '2' } });
    await new Promise((r) => setTimeout(r, 120));
    await settle();
    expect(fake.callsOf('commit_details').at(-1)!.args).toEqual({ repoId: 1, oid: hex(7), against: hex(2) });
    expect(getAllByTestId('commit-details-file-item').map((f) => f.dataset.path)).toEqual(['only-vs-parent2.txt']);
    await fireEvent.click(getAllByTestId('commit-details-file-item')[0]!);
    expect(ui.centerView.props).toEqual({ path: 'only-vs-parent2.txt', source: { kind: 'commit', oid: hex(7), parent: 2 } });
  });

  it("« ... truncated list » beyond 2,000 files; clickable parents", async () => {
    fake.on('commit_details', (a) => details(String(a.oid), { truncated: true, parents: [hex(6)] }));
    graph.selectCommit(hex(7));
    const { getByTestId } = render(CommitDetailsPanel);
    await new Promise((r) => setTimeout(r, 120));
    await settle();
    expect(getByTestId('commit-details-truncated').textContent).toBe("... truncated list");
    const revealed = vi.spyOn(captureStores().graph, 'reveal').mockResolvedValue();
    await fireEvent.click(getByTestId('commit-details-parent'));
    expect(revealed).toHaveBeenCalledWith(hex(6));
  });

  it("a reading error s'displays in the panel with Retry (without toast); the root testid remains", async () => {
    fake.reject('commit_details', { code: 'GIT_FAILED', message: 'objet illisible', details: {} });
    graph.selectCommit(hex(7));
    const { getByTestId, queryByTestId } = render(CommitDetailsPanel);
    await new Promise((r) => setTimeout(r, 120));
    await settle();
    expect(getByTestId('commit-details-panel').dataset.status).toBe('error');
    expect(getByTestId('commit-details-retry-btn')).toBeInTheDocument();
    expect(queryByTestId('toast')).toBeNull();
    await fireEvent.click(getByTestId('commit-details-retry-btn'));
    await new Promise((r) => setTimeout(r, 120));
    await settle();
    expect(getByTestId('commit-details-panel').dataset.status).toBe('ready');
  });

  it("a missing commit (NOT_FOUND oid) returns the selection to HEAD", async () => {
    const head = hex(60);
    const { repo } = await import('$lib/stores/repo.svelte');
    repo.info = { head: { branch: 'main', oid: head, detached: false, unborn: false } } as never;
    fake.on('commit_details', (a) => {
      if (a.oid === hex(7)) throw { code: 'NOT_FOUND', message: 'x', details: { what: 'oid' } } satisfies AppError;
      return details(String(a.oid));
    });
    const reveal = vi.spyOn(captureStores().graph, 'reveal').mockResolvedValue();
    graph.selectCommit(hex(7));
    render(CommitDetailsPanel);
    await new Promise((r) => setTimeout(r, 120));
    await settle();
    expect(reveal).toHaveBeenCalledWith(head);
  });
});

describe('multi-commit-panel', () => {
  const pageOf = (rows: number[]) => page(0, 0, { rows: rows.map((n) => ({ ...page(n, 1).rows[0]!, summary: `commit ${n}` })) });

  beforeEach(() => {
    graph.setPages([pageOf([1, 2, 3])]);
  });

  it("n commits selected, grouped buttons disabled as long as pick actions.* do not exist", async () => {
    graph.selectCommits([hex(1), hex(2), hex(3)], hex(1));
    const { getByTestId, getAllByTestId } = render(MultiCommitPanel);
    await settle();
    expect(getByTestId('multi-commit-title').textContent).toBe("3 commits selected");
    expect(getAllByTestId('multi-commit-item').map((i) => i.dataset.oid)).toEqual([hex(1), hex(2), hex(3)]);
    expect(getByTestId('multi-commit-cherry-pick-btn')).toBeDisabled();
    expect(getByTestId('multi-commit-revert-btn')).toBeDisabled();
    expect(fake.callsOf('commit_details')).toHaveLength(0); // no list of files beyond 2 commits
  });

  it("the buttons call pick.cherry-pick / pick.revert with the target { menu: \"commit\", oids }", async () => {
    const got: unknown[] = [];
    registerAction({ id: 'pick.cherry-pick', label: 'Cherry-pick', run: (ctx) => void got.push(['cp', ctx.target]) });
    registerAction({ id: 'pick.revert', label: 'Revert', run: (ctx) => void got.push(['rv', ctx.target]) });
    graph.selectCommits([hex(1), hex(3)], hex(1));
    const { getByTestId } = render(MultiCommitPanel);
    await settle();
    expect(getByTestId('multi-commit-cherry-pick-btn')).toBeEnabled();
    expect(getByTestId('multi-commit-cherry-pick-btn').textContent).toContain('2 commits');
    await fireEvent.click(getByTestId('multi-commit-cherry-pick-btn'));
    await fireEvent.click(getByTestId('multi-commit-revert-btn'));
    await settle();
    const target = { menu: 'commit', oid: hex(1), oids: [hex(1), hex(3)] };
    expect(got).toEqual([['cp', target], ['rv', target]]);
  });

  it("exactly 2 commits: files modified between them (commit_details { oid: récent, against: ancien }), diff \"range\"", async () => {
    fake.on('commit_details', (a) => details(String(a.oid), { files: [file("entre-les-deux.txt")] }));
    // hex(1) is more recent than hex(3) in the graph: rows 0 and 2
    graph.noteRow(hex(1), 0);
    graph.noteRow(hex(3), 2);
    graph.selectCommits([hex(3), hex(1)], hex(3));
    const { getAllByTestId } = render(MultiCommitPanel);
    await new Promise((r) => setTimeout(r, 120));
    await settle();
    expect(fake.callsOf('commit_details')[0]!.args).toEqual({ repoId: 1, oid: hex(1), against: hex(3) });
    const items = getAllByTestId('commit-details-file-item');
    expect(items.map((i) => i.dataset.path)).toEqual(["entre-les-deux.txt"]);
    await fireEvent.click(items[0]!);
    expect(ui.centerView).toEqual({ id: 'diff', props: { path: "entre-les-deux.txt", source: { kind: 'range', from: hex(3), to: hex(1) } } });
  });
});
