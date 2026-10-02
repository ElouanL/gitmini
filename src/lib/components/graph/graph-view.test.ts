// Graph view in jsdom, against a false backend: recycled pool, scroll pagination, selection, keyboard, context menus,
// search, oid refreshment (STALE / new epoch), line WIP, lines stash, empty state. Scenarios 13 : GRAPH-02, 03, 04, 05, 06.
import { fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { whenIdle } from '$lib/activity';
import { setErrorSink } from '$lib/errors/report';
import type { AppError, GraphRow, LogPage } from '$lib/ipc/types';
import { createFakeTransport, type FakeTransport } from '$lib/test/fake-transport';
import { makeRefs, makeRepoInfo, makeStashes, makeStatus } from '$lib/test/fixtures';
import { resetAll } from '$lib/test/reset';
import { registerMenuItems } from '$lib/menus/registry';
import { app } from '$lib/stores/app.svelte';
import { graph } from '$lib/stores/graph.svelte';
import { op } from '$lib/stores/op.svelte';
import { refs } from '$lib/stores/refs.svelte';
import { repo } from '$lib/stores/repo.svelte';
import { session } from '$lib/stores/session.svelte';
import { status } from '$lib/stores/status.svelte';
import { ui } from '$lib/stores/ui.svelte';
import { handleRepoChanged } from '$lib/stores/wiring';
import '$lib/register-core';
import { activeGraph } from './controller.svelte';
import GraphView from './GraphView.svelte';
import { hex } from './test-utils';

const AUTHORS = [{ name: 'Alice Martin', email: 'alice@example.org' }, { name: 'Bob Durand', email: 'bob@example.org' }];

/** Linear history of `n` commits: the r row is the commit `hex(n - r)` (the most recent first). */
class Backend {
  epoch = 1;
  /** Additional commits appeared in the lead from the beginning (external commit). */
  extra = 0;
  /** refs labels per row (line 0 is `main`, current branch). */
  labels: Record<number, GraphRow['refs']> = {};
  constructor(readonly n: number, readonly complete = true) {}
  get len(): number {
    return this.n + this.extra;
  }
  oidAt(r: number): string {
    return hex(this.len - r);
  }
  rowAt(r: number): GraphRow {
    return {
      oid: this.oidAt(r), parents: r + 1 < this.len ? [this.oidAt(r + 1)] : [], summary: `commit ${this.len - r}`, author: r % 2, time: 1_700_000_000 - r * 60,
      refs: this.labels[r] ?? (r === 0 ? [{ name: 'main', fullRef: 'refs/heads/main', kind: "local", isHead: true }] : []), lane: 0, color: r % 8, kind: 'commit', stashIndex: null, shallow: false,
      edges: r === 0 ? [0, 0, 0, 1] : r + 1 < this.len ? [0, 0, 0, 0, 0, 0, 0, 1] : [0, 0, 0, 0],
    };
  }
  page(start: number, limit = 500): LogPage {
    const end = Math.min(this.len, start + limit);
    const rows = Array.from({ length: Math.max(0, end - start) }, (_, i) => this.rowAt(start + i));
    return {
      rows, authors: AUTHORS, start, total: this.complete ? this.len : null, nextCursor: end < this.len ? `${this.epoch}:${end}` : null, epoch: this.epoch, maxLanes: 1, missing: [],
    };
  }
  logPage = (a: Record<string, unknown>): LogPage => {
    const limit = (a.limit as number | undefined) ?? 500;
    if (typeof a.cursor === 'string') {
      const [ep, off] = a.cursor.split(':').map(Number) as [number, number];
      if (ep !== this.epoch) throw { code: 'STALE', message: "outdated cursor", details: { what: 'cursor' } } satisfies AppError;
      return this.page(off, limit);
    }
    if (typeof a.startRow === 'number') return this.page(a.startRow, limit);
    if (typeof a.aroundOid === 'string') {
      const r = [...Array(this.len).keys()].find((i) => this.oidAt(i) === a.aroundOid);
      if (r === undefined) throw { code: 'NOT_FOUND', message: 'introuvable', details: { what: 'oid' } } satisfies AppError;
      return this.page(Math.max(0, r - Math.min(100, Math.floor(limit / 4))), limit);
    }
    return this.page(0, limit);
  };
  /** External Commit: an increasingly leading commit, new epoch. */
  commit(): void {
    this.extra++;
    this.epoch++;
  }
}

let fake: FakeTransport;
let be: Backend;
/** Response lock: Always released at the end of the test (a flight request would block `whenIdle` from the following tests). */
let gate: (() => void) | null = null;

const frames = async (n = 2): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => requestAnimationFrame(() => r()));
};
const settle = async (): Promise<void> => {
  await tick();
  await whenIdle();
  await frames(2);
  await tick();
};

const viewport = (): HTMLElement => document.querySelector('[data-testid="graph-viewport"]')!;
const rowEls = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-testid="graph-row"]')];
const indexes = (): number[] => rowEls().map((r) => Number(r.dataset.index)).sort((a, b) => a - b);
const rowAt = (i: number): HTMLElement => rowEls().find((r) => r.dataset.index === String(i))!;
/** Click then two frames: `data-selected` is written by the next frame, not by the manager. */
const click = async (el: Element, init: MouseEventInit = {}): Promise<void> => {
  await fireEvent.click(el, init);
  await frames(2);
};
const selectedIdx = (): number[] => rowEls().filter((r) => r.dataset.selected === 'true').map((r) => Number(r.dataset.index)).sort((a, b) => a - b);

async function mount(backend: Backend, size = { w: 1000, h: 560 }, extra: Record<string, (a: Record<string, unknown>) => unknown> = {}): Promise<void> {
  be = backend;
  fake = createFakeTransport({
    log_page: (a) => be.logPage(a),
    log_search: (a) => {
      const q = String(a.query).replace(/^msg:/, '');
      const matches = [...Array(be.len).keys()].filter((r) => be.rowAt(r).summary.includes(q)).map((r) => ({ oid: be.oidAt(r), row: r }));
      const limit = (a.limit as number | undefined) ?? 1000;
      return { matches: matches.slice(0, limit), truncated: matches.length > limit };
    },
    commit_details: (a) => ({
      oid: String(a.oid), parents: [], tree: hex(9999), author: { name: 'Alice Martin', email: 'alice@example.org', time: 1_700_000_000, offsetMinutes: 0 },
      committer: { name: 'Alice Martin', email: 'alice@example.org', time: 1_700_000_000, offsetMinutes: 0 }, message: 'sujet\n\nbody', files: [], truncated: false,
    }),
    refs_list: () => makeRefs(),
    stash_list: () => makeStashes(),
    status_get: () => makeStatus({ files: [] }),
    remote_list: () => [],
    undo_peek: () => ({ entry: null, available: false, reason: null }),
    ...extra,
  }).install();
  session.begin(1);
  repo.info = makeRepoInfo({ head: { branch: 'main', oid: be.len > 0 ? be.oidAt(0) : null, detached: false, unborn: be.len === 0 } });
  graph.setPages([be.page(0)]);
  render(GraphView);
  await tick();
  activeGraph()!.resize(size.w, size.h);
  await settle();
}

beforeEach(() => resetAll({ keepRegistrations: true }));
afterEach(() => {
  gate?.();
  gate = null;
  session.end();
});

describe('virtualisation (GRAPH-04)', () => {
  it("Ceil pool(h / 28) + 20 recycled lines; window announced by canvas", async () => {
    await mount(new Backend(5000, false));
    const pool = Math.ceil(560 / 28) + 20;
    expect(document.querySelectorAll('.gr-row')).toHaveLength(pool);
    expect(rowEls()).toHaveLength(pool);
    expect(indexes()[0]).toBe(0);
    const canvas = document.querySelector('[data-testid="graph-canvas"]')!;
    expect(canvas.getAttribute('data-row-start')).toBe('0');
    expect(canvas.getAttribute('data-row-end')).toBe(String(pool - 1));
    expect(rowAt(0).textContent).toContain('commit 5000');
    expect(rowAt(0).querySelector('[data-testid="graph-ref-label"]')!.getAttribute('data-ref')).toBe('refs/heads/main');
  });

  it("scrolling recycles the same nodes: no DOM node created or deleted", async () => {
    await mount(new Backend(5000, false));
    const mo = new MutationObserver(() => undefined);
    mo.observe(viewport(), { childList: true, subtree: true });
    const before = viewport().querySelectorAll('*').length;
    for (const top of [28 * 40, 28 * 120, 28 * 90, 0]) {
      viewport().scrollTop = top;
      await fireEvent.scroll(viewport());
      await frames(2);
    }
    expect(mo.takeRecords().filter((r) => r.type === 'childList')).toEqual([]);
    expect(viewport().querySelectorAll('*').length).toBe(before);
    mo.disconnect();
  });

  it("the window follows the scroll: first = floor(scrollTop / 28) - 10", async () => {
    await mount(new Backend(5000, false));
    viewport().scrollTop = 28 * 100;
    await fireEvent.scroll(viewport());
    await frames(2);
    expect(indexes()[0]).toBe(90);
    expect(document.querySelector('[data-testid="graph-canvas"]')!.getAttribute('data-row-start')).toBe('90');
    expect(rowAt(100).textContent).toContain('commit 4900');
    expect(activeGraph()!.visibleRange().first).toBe(100);
  });

  it("preload the next page by its cursor at less than 200 lines from the end", async () => {
    await mount(new Backend(5000, false));
    fake.calls.length = 0;
    viewport().scrollTop = 28 * 300;
    await fireEvent.scroll(viewport());
    await settle();
    const calls = fake.callsOf('log_page');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual({ repoId: 1, cursor: '1:500' });
    expect(graph.pages.map((p) => p.start)).toEqual([0, 500]);
  });

  it("a remote jump load per startRow; up to 6 pages kept; a free page is reloaded by startRow", async () => {
    await mount(new Backend(20_000));
    // page after page: the front holds 6 pages at most
    for (let p = 1; p <= 8; p++) {
      viewport().scrollTop = 28 * (p * 500 - 100);
      await fireEvent.scroll(viewport());
      await settle();
    }
    expect(graph.pages.length).toBeLessThanOrEqual(6);
    expect(graph.pages.some((p) => p.start === 0)).toBe(false); // the furthest has been released
    fake.calls.length = 0;
    viewport().scrollTop = 0;
    await fireEvent.scroll(viewport());
    await settle();
    expect(fake.callsOf('log_page')[0]!.args).toMatchObject({ cursor: null, startRow: 0 });
    expect(rowAt(0).textContent).toContain('commit 20000');
    // direct jump to the range 15,000 : startRow aligned
    fake.calls.length = 0;
    viewport().scrollTop = 28 * 15_000;
    await fireEvent.scroll(viewport());
    await settle();
    const calls = fake.callsOf('log_page').map((c) => c.args);
    // the rendered window starts at line 14 990: page aligned 14,500, then the following one with its cursor
    expect(calls[0]).toMatchObject({ cursor: null, startRow: 14_500 });
    expect(calls.some((a) => a.cursor === '1:15000')).toBe(true);
    expect(rowAt(15_000).textContent).toContain('commit 5000');
    expect(graph.pages.length).toBeLessThanOrEqual(6);
  });

  it("the text of an unloaded line is a skeleton, without blocking the scrolling", async () => {
    const closed = new Promise<void>((r) => (gate = r));
    const release = (): void => gate?.();
    await mount(new Backend(20_000), { w: 1000, h: 560 }, {});
    fake.on('log_page', async (a) => {
      await closed;
      return be.logPage(a);
    });
    viewport().scrollTop = 28 * 10_000;
    await fireEvent.scroll(viewport());
    await frames(2);
    expect(rowAt(10_000).dataset.loaded).toBe('false');
    expect(document.querySelector<HTMLElement>('[data-testid="graph-loading"]')!.hidden).toBe(false);
    release();
    await settle();
    expect(rowAt(10_000).dataset.loaded).toBe('true');
    expect(document.querySelector<HTMLElement>('[data-testid="graph-loading"]')!.hidden).toBe(true);
  });
});

describe("selection (GRAPH-02)", () => {
  beforeEach(async () => {
    await mount(new Backend(50));
  });

  it("click: unique selection by oid, commit-details panel; Mod+click; Shift+click", async () => {
    await click(rowAt(3));
    expect(graph.selection).toEqual({ kind: 'commits', oids: [be.oidAt(3)], anchor: be.oidAt(3) });
    expect(selectedIdx()).toEqual([3]);
    await click(rowAt(6), { ctrlKey: true });
    expect(graph.selectedOids).toEqual([be.oidAt(3), be.oidAt(6)]);
    await click(rowAt(3), { ctrlKey: true });
    expect(graph.selectedOids).toEqual([be.oidAt(6)]);
    await click(rowAt(2));
    await click(rowAt(5), { shiftKey: true });
    expect(graph.selectedOids).toEqual([2, 3, 4, 5].map((r) => be.oidAt(r)));
    expect(selectedIdx()).toEqual([2, 3, 4, 5]);
    expect(graph.rowHints[be.oidAt(4)]).toBe(4); // stored rank: order of comparison of two commits
  });

  it("selection survives recycling of the line (by oid, never by row)", async () => {
    await click(rowAt(5));
    viewport().scrollTop = 28 * 30;
    await fireEvent.scroll(viewport());
    await frames(2);
    expect(rowEls().some((r) => r.dataset.selected === 'true')).toBe(false);
    viewport().scrollTop = 0;
    await fireEvent.scroll(viewport());
    await frames(2);
    expect(selectedIdx()).toEqual([5]);
  });

  it("keyboard : ↑ ▼ PageDown Home End, Shift+▼ extends, line remains visible", async () => {
    viewport().focus();
    await click(rowAt(0));
    const key = async (k: string, o: KeyboardEventInit = {}) => {
      await fireEvent.keyDown(viewport(), { key: k, ...o });
      await settle();
    };
    await key('ArrowDown');
    expect(selectedIdx()).toEqual([1]);
    await key('ArrowDown', { shiftKey: true });
    expect(selectedIdx()).toEqual([1, 2]);
    await key('ArrowUp');
    expect(selectedIdx()).toEqual([1]);
    await key('End');
    expect(selectedIdx()).toEqual([49]);
    const r = activeGraph()!.visibleRange();
    expect(r.last).toBe(49);
    await key('Home');
    expect(selectedIdx()).toEqual([0]);
    expect(activeGraph()!.visibleRange().first).toBe(0);
    await key('PageDown');
    expect(selectedIdx()[0]).toBe(Math.floor(560 / 28) - 1);
    expect(activeGraph()!.visibleRange().first).toBeGreaterThan(0); // the page has turned
  });

  it("Input gives the focus to the right panel (data-zone)", async () => {
    const right = document.createElement('div');
    right.setAttribute('data-zone', 'right');
    const btn = document.createElement('button');
    right.appendChild(btn);
    document.body.appendChild(right);
    await click(rowAt(1));
    await fireEvent.keyDown(viewport(), { key: 'Enter' });
    expect(document.activeElement).toBe(btn);
    right.remove();
  });
});

describe("accessibility and columns", () => {
  it("the keyboard cursor is announced by aria-activedescendant (the focus remains on the viewport)", async () => {
    await mount(new Backend(50));
    expect(viewport().hasAttribute('aria-activedescendant')).toBe(false);
    await click(rowAt(4));
    expect(viewport().getAttribute('aria-activedescendant')).toBe(rowAt(4).id);
    await fireEvent.keyDown(viewport(), { key: 'ArrowDown' });
    await settle();
    expect(viewport().getAttribute('aria-activedescendant')).toBe(rowAt(5).id);
    expect(viewport().getAttribute('role')).toBe('listbox');
    expect(rowAt(5).getAttribute('role')).toBe('option');
    expect(rowAt(5).getAttribute('aria-selected')).toBe('true');
  });

  it("narrow area: SHA, then Date, then Author are masked (cells with 0 width kept in the grid)", async () => {
    await mount(new Backend(50), { w: 1200, h: 400 });
    const root = document.querySelector<HTMLElement>('[data-testid="graph"]')!;
    expect(root.hasAttribute('data-no-sha')).toBe(false);
    activeGraph()!.resize(700, 400);
    await settle();
    expect(root.hasAttribute('data-no-sha')).toBe(true);
    expect(root.hasAttribute('data-no-date')).toBe(false);
    expect(root.style.getPropertyValue('--c-sha')).toBe('0px');
    activeGraph()!.resize(520, 400);
    await settle();
    expect(root.hasAttribute('data-no-author')).toBe(true);
    expect(root.style.getPropertyValue('--c-author')).toBe('0px');
  });

  it("the complete subject is in infobulle (title) when the column truncates", async () => {
    await mount(new Backend(50));
    expect(rowAt(0).querySelector('.gr-msg')!.getAttribute('title')).toBe('commit 50');
  });
});

describe("labels of refs", () => {
  it("double-clic on a non-current local branch: branch_checkout { kind: \"local\" }; on the current: nothing", async () => {
    const b = new Backend(50);
    b.labels = { 5: [{ name: 'feature/login', fullRef: 'refs/heads/feature/login', kind: "local", isHead: false }] };
    await mount(b, { w: 1000, h: 560 }, { branch_checkout: () => makeRefs() });
    refs.apply(makeRefs());
    fake.calls.length = 0;
    await fireEvent.dblClick(rowAt(0).querySelector('[data-testid="graph-ref-label"]')!); // main : courante
    await settle();
    expect(fake.callsOf('branch_checkout')).toHaveLength(0);
    await fireEvent.dblClick(rowAt(5).querySelector('[data-testid="graph-ref-label"]')!);
    await settle();
    expect(fake.callsOf('branch_checkout')[0]!.args).toEqual({ repoId: 1, target: { kind: "local", name: 'feature/login' } });
  });

  it("double-clic on a remote: remote checkout; on a commit: no action in v1", async () => {
    const b = new Backend(50);
    b.labels = { 3: [{ name: 'origin/dev', fullRef: 'refs/remotes/origin/dev', kind: 'remote', isHead: false }] };
    await mount(b, { w: 1000, h: 560 }, { branch_checkout: () => makeRefs() });
    refs.apply(makeRefs());
    fake.calls.length = 0;
    await fireEvent.dblClick(rowAt(7));
    expect(fake.callsOf('branch_checkout')).toHaveLength(0);
    await fireEvent.dblClick(rowAt(3).querySelector('[data-testid="graph-ref-label"]')!);
    await settle();
    expect(fake.callsOf('branch_checkout')[0]!.args).toEqual({ repoId: 1, target: { kind: 'remote', ref: 'origin/dev' } });
  });

  it("no checkout during flight writing", async () => {
    const b = new Backend(50);
    b.labels = { 5: [{ name: 'feature/login', fullRef: 'refs/heads/feature/login', kind: "local", isHead: false }] };
    await mount(b, { w: 1000, h: 560 }, { branch_checkout: () => makeRefs() });
    refs.apply(makeRefs());
    const end = op.begin('Commit');
    fake.calls.length = 0;
    await fireEvent.dblClick(rowAt(5).querySelector('[data-testid="graph-ref-label"]')!);
    await settle();
    expect(fake.callsOf('branch_checkout')).toHaveLength(0);
    end();
  });
});

describe('requestReveal', () => {
  it("scrolls to an unloaded commit (roundOid) without changing the selection", async () => {
    await mount(new Backend(5000));
    await click(rowAt(2));
    const target = be.oidAt(3000);
    fake.calls.length = 0;
    graph.requestReveal(target);
    await settle();
    expect(fake.callsOf('log_page')[0]!.args).toMatchObject({ aroundOid: target });
    const r = activeGraph()!.visibleRange();
    expect(r.first).toBeLessThanOrEqual(3000);
    expect(r.last).toBeGreaterThanOrEqual(3000);
    expect(graph.selectedOids).toEqual([be.oidAt(2)]);
  });
});

describe('clavier : menu contextuel', () => {
  it("Shift+F10 opens the keyboard cursor line menu", async () => {
    await mount(new Backend(50));
    await click(rowAt(4));
    await fireEvent.keyDown(viewport(), { key: 'F10', shiftKey: true });
    expect(ui.contextMenu?.target).toEqual({ menu: 'commit', oid: be.oidAt(4), oids: [be.oidAt(4)] });
    expect(ui.contextMenu?.returnFocus).toBe(viewport());
  });
});

describe('clic droit', () => {
  it("an unselected line replaces it, then opens context-menu[data-menu=commit] with the selected oids", async () => {
    await mount(new Backend(50));
    await fireEvent.click(rowAt(1));
    await fireEvent.click(rowAt(2), { ctrlKey: true });
    await fireEvent.contextMenu(rowAt(7), { clientX: 10, clientY: 20 });
    expect(graph.selectedOids).toEqual([be.oidAt(7)]);
    expect(ui.contextMenu?.target).toEqual({ menu: 'commit', oid: be.oidAt(7), oids: [be.oidAt(7)] });
    // a line in selects it
    await fireEvent.click(rowAt(1));
    await fireEvent.click(rowAt(2), { ctrlKey: true });
    await fireEvent.contextMenu(rowAt(2));
    expect(ui.contextMenu?.target).toEqual({ menu: 'commit', oid: be.oidAt(2), oids: [be.oidAt(1), be.oidAt(2)] });
  });

  it("a branch tag opens the branch menu (Snapshot's FlashInfo), a remote remote-branch", async () => {
    await mount(new Backend(50));
    refs.apply(makeRefs());
    await fireEvent.contextMenu(rowAt(0).querySelector('[data-testid="graph-ref-label"]')!);
    const t = ui.contextMenu?.target;
    expect(t?.menu).toBe('branch');
    if (t?.menu === 'branch') expect(t.branch).toMatchObject({ name: 'main', fullRef: 'refs/heads/main', isHead: true });
  });
});

describe("line WIP and lines stash", () => {
  it("WIP at the top of the graph when the status has files; counters; it disappears when the repository is clean", async () => {
    await mount(new Backend(50));
    expect(document.querySelector('[data-testid="graph-wip-row"]')).toBeNull();
    status.apply(makeStatus());
    await settle();
    const wip = document.querySelector('[data-testid="graph-wip-row"]')!;
    expect(wip.closest('.gr-row')!.getAttribute('data-kind')).toBe('wip');
    expect(wip.closest('.gr-row')!.getAttribute('data-index')).toBe('-1');
    expect(wip.closest('.gr-row')!.textContent).toContain('// WIP');
    expect(wip.closest('.gr-row')!.textContent).toContain('✎ 2'); // README modified staged + 2 unstaged ? see makeStatus
    expect(indexes()[0]).toBe(-1);
    expect(rowAt(0).getAttribute('style')).toContain('translateY(28px)'); // offset by a line
    await fireEvent.click(wip);
    expect(graph.selection).toEqual({ kind: 'wip' });
    status.apply(makeStatus({ files: [] }));
    await settle();
    expect(document.querySelector('[data-testid="graph-wip-row"]')).toBeNull();
    expect(graph.selection.kind).toBe('none');
  });

  it("a stash line carries graph-stash-row[data-stash-index]; one click selects it; stash menu", async () => {
    const b = new Backend(30);
    const stash: GraphRow = { ...b.rowAt(2), oid: hex(900), kind: 'stash', stashIndex: 0, summary: 'On main: wip', parents: [b.oidAt(3)], refs: [] };
    const orig = b.page.bind(b);
    b.page = (s, l) => {
      const p = orig(s, l);
      return { ...p, rows: p.rows.map((r, i) => (s + i === 2 ? stash : r)) };
    };
    await mount(b);
    refs.applyStashes(makeStashes().map((s, i) => (i === 0 ? { ...s, oid: hex(900) } : s)));
    registerMenuItems('stash', [{ id: 'stash-apply', label: "Apply", run: () => undefined }]);
    const el = document.querySelector('[data-testid="graph-stash-row"]')!;
    expect(el.getAttribute('data-stash-index')).toBe('0');
    expect(el.closest('.gr-row')!.textContent).toContain('stash@{0}: On main: wip');
    await fireEvent.click(el);
    expect(graph.selection).toEqual({ kind: 'stash', oid: hex(900), index: 0 });
    await fireEvent.contextMenu(el);
    expect(ui.contextMenu?.target.menu).toBe('stash');
  });
});

describe("Statement", () => {
  it("repository without commit: graph-empty-state, no lines", async () => {
    await mount(new Backend(0));
    expect(document.querySelector('[data-testid="graph-empty-state"]')!.textContent).toBe("Make your first commit.");
    expect(rowEls()).toHaveLength(0);
    expect(document.querySelector('[data-testid="toast"][data-kind="error"]')).toBeNull();
  });

  it("commits out of line HEAD blurred (graph.dimUnreachable)", async () => {
    const b = new Backend(20);
    const orig = b.page.bind(b);
    // row 0 = other branch (not reachable); HEAD = row 1
    b.page = (s, l) => {
      const p = orig(s, l);
      return { ...p, rows: p.rows.map((r, i) => (s + i === 0 ? { ...r, parents: [b.oidAt(2)] } : r)) };
    };
    await mount(b);
    repo.info = makeRepoInfo({ head: { branch: 'main', oid: b.oidAt(1), detached: false, unborn: false } });
    refs.apply({ ...makeRefs(), head: { kind: 'detached', oid: b.oidAt(1) }, local: [] });
    await settle();
    expect(rowAt(0).dataset.dim).toBe('true');
    expect(rowAt(1).dataset.dim).toBe('false');
    expect(rowAt(2).dataset.dim).toBe('false');
  });
});

describe("oid refreshment (GRAPH-06)", () => {
  it("commit external: new epoch, old page kept until new, selection preserved by oid, no toast", async () => {
    await mount(new Backend(50));
    await fireEvent.click(rowAt(5));
    const sel = be.oidAt(5);
    be.commit();
    fake.calls.length = 0;
    handleRepoChanged({ repoId: 1, kinds: ['refs', 'head'] });
    // the old page remains displayed during the rereading: no empty flash
    expect(rowEls().length).toBeGreaterThan(0);
    await settle();
    expect(graph.epoch).toBe(2);
    expect(rowAt(0).textContent).toContain('commit 51');
    expect(graph.selectedOids).toEqual([sel]);
    expect(selectedIdx()).toEqual([6]); // the same commit, a lower line
    expect(document.querySelector('[data-testid="toast"]')).toBeNull();
    expect(fake.callsOf('log_page')).toHaveLength(1);
  });

  it("parade in depth: the rereading is done by roundOid of the first visible line and keeps the position", async () => {
    await mount(new Backend(3000));
    viewport().scrollTop = 28 * 1200 + 9;
    await fireEvent.scroll(viewport());
    await settle();
    const first = activeGraph()!.visibleRange().first;
    const oid = be.oidAt(first);
    be.commit();
    fake.calls.length = 0;
    handleRepoChanged({ repoId: 1, kinds: ['refs'] });
    await settle();
    expect(fake.callsOf('log_page')[0]!.args).toMatchObject({ aroundOid: oid });
    expect(activeGraph()!.visibleRange().first).toBe(first + 1); // same commit at the top, a line further
    expect(viewport().scrollTop).toBe(28 * (first + 1) + 9);
  });

  it("STALE { what: \"cursor\" }: Silent charging around the 1st visible line, without message", async () => {
    await mount(new Backend(5000, false));
    be.commit(); // the backend epoch moves forward, the front still ignores it
    fake.calls.length = 0;
    viewport().scrollTop = 28 * 300; // preload the next page with the old cursor → STALE
    await fireEvent.scroll(viewport());
    await settle();
    const calls = fake.callsOf('log_page').map((c) => c.args);
    expect(calls[0]).toMatchObject({ cursor: '1:500' });
    expect(calls.some((a) => typeof a.aroundOid === 'string')).toBe(true);
    expect(graph.epoch).toBe(2);
    expect(document.querySelector('[data-testid="toast"]')).toBeNull();
    expect(rowEls().length).toBeGreaterThan(0);
  });

  it("AroundOid not found: first page, empty selection", async () => {
    await mount(new Backend(3000));
    viewport().scrollTop = 28 * 1500;
    await fireEvent.scroll(viewport());
    await settle();
    await fireEvent.click(rowAt(activeGraph()!.visibleRange().first + 2));
    // the displayed line disappears from the history
    be.logPage = ((orig) => (a: Record<string, unknown>) => {
      if (typeof a.aroundOid === 'string') throw { code: 'NOT_FOUND', message: 'introuvable', details: { what: 'oid' } } satisfies AppError;
      return orig(a);
    })(be.logPage);
    handleRepoChanged({ repoId: 1, kinds: ['refs'] });
    await settle();
    expect(graph.selection.kind).toBe('none');
    expect(activeGraph()!.visibleRange().first).toBe(0);
  });
});

describe('recherche (GRAPH-03)', () => {
  const type = async (value: string): Promise<void> => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="graph-search-input"]')!;
    await fireEvent.input(input, { target: { value } });
    await new Promise((r) => setTimeout(r, 200)); // debounce de 150 ms
    await settle();
  };
  const count = (): string => document.querySelector('[data-testid="graph-search-count"]')!.textContent!;

  it("input → result is selected and visible, counter 1 / 1 ; close keeps selection", async () => {
    await mount(new Backend(50));
    graph.searchOpen = true;
    await settle();
    const input = document.querySelector<HTMLInputElement>('[data-testid="graph-search-input"]')!;
    expect(document.activeElement).toBe(input);
    await type('commit 7');
    expect(count()).toBe('1 / 1');
    expect(graph.selectedOids).toEqual([be.oidAt(43)]); // « commit 7 » = rang 43 de l'historique
    expect(selectedIdx()).toEqual([43]);
    expect(input.dataset.emptyResult).toBeUndefined();
    await fireEvent.click(document.querySelector('[data-testid="graph-search-close-btn"]')!);
    await settle();
    expect(document.querySelector('[data-testid="graph-search"]')).toBeNull();
    expect(graph.selectedOids).toEqual([be.oidAt(43)]);
  });

  it("several results : Enter / Shift+Enter / buttons next and previous, with closure", async () => {
    await mount(new Backend(50));
    graph.searchOpen = true;
    await settle();
    await type('commit 1'); // commit 1, 10..19
    expect(count()).toBe('1 / 11');
    const first = graph.selectedOids[0];
    const input = document.querySelector<HTMLInputElement>('[data-testid="graph-search-input"]')!;
    await fireEvent.keyDown(input, { key: 'Enter' });
    await settle();
    expect(count()).toBe('2 / 11');
    expect(graph.selectedOids[0]).not.toBe(first);
    await fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    await fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    await settle();
    expect(count()).toBe('11 / 11');
    await fireEvent.click(document.querySelector('[data-testid="graph-search-next-btn"]')!);
    await settle();
    expect(count()).toBe('1 / 11');
    await fireEvent.click(document.querySelector('[data-testid="graph-search-prev-btn"]')!);
    await settle();
    expect(count()).toBe('11 / 11');
  });

  it("no result : 0 / 0 and data-empty-result, no error", async () => {
    await mount(new Backend(50));
    graph.searchOpen = true;
    await settle();
    await type('introuvable');
    expect(count()).toBe('0 / 0');
    expect(document.querySelector<HTMLInputElement>('[data-testid="graph-search-input"]')!.dataset.emptyResult).toBe('true');
    expect(document.querySelector('[data-testid="toast"]')).toBeNull();
  });

  it("a result out of loaded pages: log_page { startRow } then scroll centered", async () => {
    await mount(new Backend(20_000));
    graph.searchOpen = true;
    await settle();
    fake.calls.length = 0;
    await type('commit 12345'); // rang 7655
    await settle();
    expect(fake.callsOf('log_page').some((c) => c.args.startRow === 7500)).toBe(true);
    expect(selectedIdx()).toEqual([7655]);
    const r = activeGraph()!.visibleRange();
    expect(r.first).toBeLessThanOrEqual(7655);
    expect(r.last).toBeGreaterThanOrEqual(7655);
    expect(graph.pages.length).toBeLessThanOrEqual(6);
  });

  it("the lines found are marked for Canvas (highlight) and a new epoch restarts the search", async () => {
    await mount(new Backend(50));
    graph.searchOpen = true;
    await settle();
    await type('commit 1');
    fake.calls.length = 0;
    be.commit();
    handleRepoChanged({ repoId: 1, kinds: ['refs'] });
    await settle();
    expect(fake.callsOf('log_search').length).toBeGreaterThan(0);
    expect(graph.selectedOids).toHaveLength(1);
  });
});

const failure = (code: AppError['code'] = 'GIT_FAILED'): AppError => ({ code, message: `failure ${code}`, details: {} });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("IPC errors never swallowed (01 §74)", () => {
  let errs: AppError[];
  beforeEach(() => {
    errs = [];
    setErrorSink((e) => void errs.push(e));
  });

  it("total probe: error is routed once, probe stops, rereading next re-launch", async () => {
    const b = new Backend(5000, false);
    const orig = b.logPage;
    b.logPage = (a) => {
      if (a.limit === 1) throw failure('GIT_FAILED');
      return orig(a);
    };
    await mount(b);
    const probes = (): number => fake.callsOf('log_page').filter((c) => c.args.limit === 1).length;
    await sleep(400); // 1st lap at 150 ms; without stopping, the 2nd would come at ~390 ms
    expect(errs.map((e) => e.code)).toEqual(['GIT_FAILED']);
    expect(probes()).toBe(1);
    await sleep(500);
    expect(probes()).toBe(1);
    be.commit(); // new epoch: rereading, total still unknown → probe restarted
    handleRepoChanged({ repoId: 1, kinds: ['refs'] });
    await settle();
    await sleep(250);
    expect(probes()).toBe(2);
    expect(errs).toHaveLength(2);
  });

  it("End key with unknown total: Total Solve Failure is routed, graph remains usable", async () => {
    await mount(new Backend(5000, false));
    be.logPage = ((orig) => (a: Record<string, unknown>) => {
      if (a.startRow === 1_000_000_000) throw failure('NETWORK');
      return orig(a);
    })(be.logPage);
    viewport().focus();
    await click(rowAt(2));
    await fireEvent.keyDown(viewport(), { key: 'End' });
    await settle();
    expect(errs.map((e) => e.code)).toContain('NETWORK');
    expect(activeGraph()!.pagesLoading).toBe(false);
    await fireEvent.keyDown(viewport(), { key: 'Home' });
    await settle();
    expect(selectedIdx()).toEqual([0]);
  });

  it("oid rereading fails: routed error, old page remains displayed", async () => {
    await mount(new Backend(50));
    be.commit();
    be.logPage = () => {
      throw failure('GIT_FAILED');
    };
    handleRepoChanged({ repoId: 1, kinds: ['refs'] });
    await settle();
    expect(errs.map((e) => e.code)).toEqual(['GIT_FAILED']);
    expect(graph.epoch).toBe(1);
    expect(rowEls().length).toBeGreaterThan(0);
    expect(rowAt(0).textContent).toContain('commit 50');
  });

  it("page loading (cursor) that fails: routed error, no recovery loop", async () => {
    await mount(new Backend(5000, false));
    be.logPage = ((orig) => (a: Record<string, unknown>) => {
      if (typeof a.cursor === 'string') throw failure('NETWORK');
      return orig(a);
    })(be.logPage);
    fake.calls.length = 0;
    viewport().scrollTop = 28 * 300;
    await fireEvent.scroll(viewport());
    await settle();
    expect(errs.map((e) => e.code)).toEqual(['NETWORK']);
    expect(fake.callsOf('log_page').filter((c) => typeof c.args.cursor === 'string')).toHaveLength(1);
  });

  it("STALE { what: \"cursor\" } remains silent by contract: reloading without any routing errors", async () => {
    await mount(new Backend(5000, false));
    be.commit();
    viewport().scrollTop = 28 * 300;
    await fireEvent.scroll(viewport());
    await settle();
    expect(graph.epoch).toBe(2);
    expect(errs).toEqual([]);
  });

  it("unexpected exception during keyboard navigation: routed, the following keys line continues", async () => {
    await mount(new Backend(50));
    viewport().focus();
    await click(rowAt(0));
    const spy = vi.spyOn(activeGraph()!, 'pageStep').mockImplementation(() => {
      throw new Error('boum');
    });
    await fireEvent.keyDown(viewport(), { key: 'ArrowDown' });
    await settle();
    expect(errs.map((e) => e.message)).toEqual(['boum']);
    expect(selectedIdx()).toEqual([0]);
    spy.mockRestore();
    await fireEvent.keyDown(viewport(), { key: 'ArrowDown' });
    await settle();
    expect(selectedIdx()).toEqual([1]);
    expect(errs).toHaveLength(1);
  });
});

describe("theme of the Canvas (03 \"Themes\")", () => {
  let style: HTMLStyleElement;
  beforeEach(() => {
    style = document.createElement('style');
    style.textContent = [
      ':root { --lane-0: #112233; --bg: #fafafa; --row-selected: #c0d0f0; }',
      ":root[data-theme='dark'] { --lane-0: #aabbcc; --bg: #0d1117; --row-selected: #1f3a5f; }",
    ].join('\n');
    document.head.appendChild(style);
    app.settings = { ...app.settings, theme: 'light' };
    app.applyTheme();
  });
  afterEach(() => {
    style.remove();
    delete document.documentElement.dataset.theme;
  });

  it("the change of theme rereads the palette UNE times and redraws; the return to the clear theme restores the", async () => {
    await mount(new Backend(50));
    const ctrl = activeGraph()!;
    expect(ctrl.palette.lanes[0]).toBe('#112233');
    expect(ctrl.palette.bg).toBe('#fafafa');
    ctrl.resetDrawTimes();
    app.settings = { ...app.settings, theme: 'dark' };
    app.applyTheme();
    await settle();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(ctrl.palette.lanes[0]).toBe('#aabbcc');
    expect(ctrl.palette.bg).toBe('#0d1117');
    expect(ctrl.palette.selected).toBe('#1f3a5f');
    expect(ctrl.drawTimes().length).toBeGreaterThan(0); // a frame has been redesigned without any other event
    app.settings = { ...app.settings, theme: 'light' };
    app.applyTheme();
    await settle();
    expect(ctrl.palette.lanes[0]).toBe('#112233');
    expect(ctrl.palette.bg).toBe('#fafafa');
  });

  it("without changing the theme, the palette is not reread (same object)", async () => {
    await mount(new Backend(50));
    const ctrl = activeGraph()!;
    const before = ctrl.palette;
    viewport().scrollTop = 28 * 3;
    await fireEvent.scroll(viewport());
    await frames(3);
    app.applyTheme(); // theme unchanged: themeVersion is not incremented
    await settle();
    expect(ctrl.palette).toBe(before);
  });
});

describe("repository empty with files and keyboard resynchronization", () => {
  it("repository without commit but with files: the line WIP is alone, with the empty status message below", async () => {
    await mount(new Backend(0));
    const unborn = { branch: 'main', oid: null, detached: false, unborn: true };
    refs.apply({ ...makeRefs(), head: { kind: 'unborn', name: 'main' }, local: [], remote: [] });
    status.apply(makeStatus({ head: unborn }));
    await settle();
    expect(rowEls()).toHaveLength(1);
    const row = rowAt(-1);
    expect(row.dataset.kind).toBe('wip');
    expect(row.querySelector('[data-testid="graph-wip-row"]')).not.toBeNull();
    expect(row.textContent).toContain('// WIP');
    const empty = document.querySelector<HTMLElement>('[data-testid="graph-empty-state"]')!;
    expect(empty.textContent).toBe("Make your first commit.");
    expect(empty.style.top).toBe('28px'); // under the line WIP, not on
    expect(activeGraph()!.headRow).toBe(-3); // no HEAD: the WIP node is not connected to anything
    await click(row);
    expect(graph.selection).toEqual({ kind: 'wip' });
    // keys do not crash on a list reduced to the line WIP
    viewport().focus();
    for (const key of ['ArrowDown', 'End', 'Home']) await fireEvent.keyDown(viewport(), { key });
    await settle();
    expect(graph.selection).toEqual({ kind: 'wip' });
    // repository becomes clean again: more WIP, empty state goes up
    status.apply(makeStatus({ head: unborn, files: [] }));
    await settle();
    expect(rowEls()).toHaveLength(0);
    expect(document.querySelector<HTMLElement>('[data-testid="graph-empty-state"]')!.style.top).toBe('0px');
  });

  it("after a refresh, the cursor and anchor of the keyboard follow their commit (by oid), not their rank", async () => {
    await mount(new Backend(50));
    viewport().focus();
    await click(rowAt(5));
    await fireEvent.keyDown(viewport(), { key: 'ArrowDown' });
    await settle();
    const ctrl = activeGraph()!;
    expect(selectedIdx()).toEqual([6]);
    expect([ctrl.cursorRow, ctrl.anchorRow]).toEqual([6, 6]);
    be.commit(); // one more commit: all rows slide from one line
    handleRepoChanged({ repoId: 1, kinds: ['refs', 'head'] });
    await settle();
    expect(selectedIdx()).toEqual([7]);
    expect([ctrl.cursorRow, ctrl.anchorRow]).toEqual([7, 7]);
    await fireEvent.keyDown(viewport(), { key: 'ArrowDown' });
    await settle();
    expect(selectedIdx()).toEqual([8]); // and not [7]: the cursor did not stay on the old row
    await fireEvent.keyDown(viewport(), { key: 'ArrowDown', shiftKey: true });
    await settle();
    expect(selectedIdx()).toEqual([8, 9]); // the anchor (range 8) also follows
  });

  it("after a refresh, a missing selection of history resets the cursor to zero", async () => {
    await mount(new Backend(3000));
    viewport().scrollTop = 28 * 1500;
    await fireEvent.scroll(viewport());
    await settle();
    await click(rowAt(activeGraph()!.visibleRange().first + 2));
    expect(activeGraph()!.cursorRow).not.toBeNull();
    be.logPage = ((orig) => (a: Record<string, unknown>) => {
      if (typeof a.aroundOid === 'string') throw { code: 'NOT_FOUND', message: 'introuvable', details: { what: 'oid' } } satisfies AppError;
      return orig(a);
    })(be.logPage);
    handleRepoChanged({ repoId: 1, kinds: ['refs'] });
    await settle();
    expect(graph.selection.kind).toBe('none');
    expect(activeGraph()!.cursorRow).toBeNull();
    expect(activeGraph()!.anchorRow).toBeNull();
  });
});
