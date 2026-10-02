import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogPage } from '$lib/ipc/types';
import { whenIdle } from '$lib/activity';
import { page } from '../test-utils';
import type { AddPageResult } from '$lib/stores/graph.svelte';
import { PageLoader, TotalProbe, type LoaderDeps } from './loader';
import { mergePage, type LoadRequest } from './pages';

interface Harness {
  loader: PageLoader;
  pages: LogPage[];
  requests: LoadRequest[];
  deps: LoaderDeps;
  view: { firstRow: number; lastRow: number; center: number } | null;
  total: number | null;
  current: boolean;
  loading: boolean[];
}

/** False backend: a history of `n` lines, pages of requested size, cursor `1:<offset>`. */
function harness(n: number, over: Partial<LoaderDeps> = {}): Harness {
  const h = {
    pages: [] as LogPage[], requests: [] as LoadRequest[], view: { firstRow: 0, lastRow: 40, center: 20 } as Harness['view'], total: null as number | null,
    current: true, loading: [] as boolean[],
  } as Harness;
  const serve = (start: number, limit: number): LogPage => {
    const count = Math.max(0, Math.min(limit, n - start));
    return page(start, count, { nextCursor: start + count < n ? `1:${start + count}` : null, total: n });
  };
  h.deps = {
    fetch: async (req) => {
      h.requests.push(req);
      if (req.kind === 'cursor') return serve(Number(req.cursor.split(':')[1]), 500);
      return serve(req.startRow, req.limit);
    },
    getPages: () => h.pages,
    getTotal: () => h.total,
    getView: () => h.view,
    apply: (p): AddPageResult => {
      h.pages = mergePage(h.pages, p);
      if (p.total !== null) h.total = p.total;
      return 'added';
    },
    noteMeta: (p) => {
      if (p.total !== null) h.total = p.total;
    },
    onStale: vi.fn(),
    onError: vi.fn(),
    isCurrent: () => h.current,
    onLoading: (l) => h.loading.push(l),
    isStaleCursor: (e) => (e as { code?: string }).code === 'STALE',
    ...over,
  };
  h.loader = new PageLoader(h.deps);
  return h;
}

describe("loading pages", () => {
  it("first empty window: load the visible page and then stop", async () => {
    const h = harness(5000);
    h.loader.ensure();
    await whenIdle();
    expect(h.requests).toEqual([{ kind: 'startRow', startRow: 0, limit: 500 }]);
    expect(h.pages).toHaveLength(1);
  });

  it("preload the next page by its cursor at less than 200 lines from the end", async () => {
    const h = harness(5000);
    h.pages = [page(0, 500)];
    h.view = { firstRow: 250, lastRow: 320, center: 280 };
    h.loader.ensure();
    await whenIdle();
    expect(h.requests).toEqual([{ kind: 'cursor', cursor: '1:500', start: 500 }]);
    expect(h.pages.map((p) => p.start)).toEqual([0, 500]);
  });

  it("a jump loads per startRow; a hole fills; never twice the same page", async () => {
    const h = harness(100_000);
    h.pages = [page(0, 500)];
    h.view = { firstRow: 50_000, lastRow: 50_060, center: 50_030 };
    h.loader.ensure();
    await whenIdle();
    expect(h.requests[0]).toEqual({ kind: 'startRow', startRow: 50_000, limit: 500 });
    expect(new Set(h.requests.map((r) => JSON.stringify(r))).size).toBe(h.requests.length);
    expect(h.pages.some((p) => p.start === 50_000)).toBe(true);
  });

  it("an empty page beyond the end does not loop", async () => {
    const h = harness(100);
    h.pages = [page(0, 100, { nextCursor: '1:100' })];
    h.view = { firstRow: 50, lastRow: 200, center: 100 };
    h.loader.ensure();
    await whenIdle();
    expect(h.requests.length).toBeLessThanOrEqual(2);
    expect(h.total).toBe(100);
  });

  it("an outdated cursor (STALE) triggers the reloading of the visible page, silently", async () => {
    const h = harness(5000, { fetch: async () => Promise.reject({ code: 'STALE', message: 'x' }) });
    h.pages = [page(0, 500)];
    h.view = { firstRow: 300, lastRow: 400, center: 350 };
    h.loader.ensure();
    await whenIdle();
    expect(h.deps.onStale).toHaveBeenCalledTimes(1);
    expect(h.deps.onError).not.toHaveBeenCalled();
  });

  it("another error is gone", async () => {
    const h = harness(5000, { fetch: async () => Promise.reject({ code: 'GIT_FAILED', message: 'x' }) });
    h.loader.ensure();
    await whenIdle();
    expect(h.deps.onError).toHaveBeenCalledTimes(1);
  });

  it("a more recent epoch (\"newer\") reloads the visible page instead of mixing epochs", async () => {
    const h = harness(5000, { apply: () => 'newer' });
    h.loader.ensure();
    await whenIdle();
    expect(h.deps.onStale).toHaveBeenCalledTimes(1);
    expect(h.requests).toHaveLength(1);
  });

  it("repository changed during query: answer is discarded", async () => {
    const h = harness(5000);
    const fetch = h.deps.fetch;
    h.deps.fetch = async (r) => {
      const p = await fetch(r);
      h.current = false;
      return p;
    };
    h.loader = new PageLoader(h.deps);
    h.loader.ensure();
    await whenIdle();
    expect(h.pages).toHaveLength(0);
  });

  it("unmounted view: nothing", async () => {
    const h = harness(5000);
    h.view = null;
    h.loader.ensure();
    await whenIdle();
    expect(h.requests).toEqual([]);
  });

  it("notify loading in progress", async () => {
    const h = harness(5000);
    h.loader.ensure();
    await whenIdle();
    expect(h.loading[0]).toBe(true);
    expect(h.loading.at(-1)).toBe(false);
  });
});

describe('sonde de total', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("repeats at increasing intervals until the total", async () => {
    let total: number | null = null;
    const probe = vi.fn(async () => {
      if (probe.mock.calls.length === 3) total = 100;
    });
    const p = new TotalProbe(probe, () => total !== null);
    p.start();
    await vi.advanceTimersByTimeAsync(149);
    expect(probe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(probe).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5000);
    expect(probe).toHaveBeenCalledTimes(3); // total obtained: probe stops
  });

  it("stop cancels the pending tour", async () => {
    const probe = vi.fn(async () => undefined);
    const p = new TotalProbe(probe, () => false);
    p.start();
    p.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(probe).not.toHaveBeenCalled();
  });
});
