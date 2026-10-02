// GRAPH-04 — Graph: pagination and virtualization (, , ) Fixture `perf-100k`; Linux only: @linux-only
// (fixing weighs ~100 MB and rendering budgets are Linux/Xvfb).
import { expect } from '@wdio/globals';
import { appReady, countOf, idle, press, until } from '../../support/ui';

interface Bridge {
  pages(): { start: number; end: number }[];
  total(): number | null;
  poolSize(): number;
  visibleRange(): { first: number; last: number };
  pageRequests(): { total: number; cursor: number; startRow: number; around: number; refresh: number; probe: number };
}

const bridge = <T>(fn: (g: Bridge) => T): Promise<T> =>
  browser.execute((src: string) => new Function('g', `return (${src})(g)`)((window as unknown as { __gitmini: { graph: Bridge } }).__gitmini.graph) as never, fn.toString()) as Promise<T>;

describe("GRAPH-04 — Graph: pagination and virtualization", () => {
  it("GRAPH-04 — End then PageUp, jump to line 50,000: no more than 6 pages, constant pool, no DOM node created or deleted, requested pages bounded", async () => {
    await appReady();
    await until(async () => (await bridge((g) => g.total())) === 100_000, { message: "full index (100 000 lines)", timeout: 20_000 });
    const pool = await bridge((g) => g.poolSize());
    expect(await countOf('graph-row')).toBe(pool);

    // Mutation observer: scrolling does not create or remove any nodes from the viewport.
    await browser.execute(() => {
      const w = window as unknown as { __mut: number };
      w.__mut = 0;
      new MutationObserver((records) => {
        for (const r of records) if (r.type === 'childList') w.__mut += r.addedNodes.length + r.removedNodes.length;
      }).observe(document.querySelector('[data-testid="graph-viewport"]')!, { childList: true, subtree: true });
      document.querySelector<HTMLElement>('[data-testid="graph-viewport"]')!.focus();
    });
    const requestsBefore = (await bridge((g) => g.pageRequests())).total;

    // End: last line (total is known, no probe required), then PageUp.
    await press('End');
    await until(async () => (await bridge((g) => g.visibleRange())).last === 99_999, { message: "last line visible" });
    await idle();
    expect((await bridge((g) => g.pages())).length).toBeLessThanOrEqual(6);
    await press('PageUp');
    await idle();
    expect((await bridge((g) => g.visibleRange())).last).toBeLessThan(99_999);

    // Jump to the middle: the page is loaded by startRow, the furthest are released (6 pages maximum).
    await browser.execute(() => {
      document.querySelector<HTMLElement>('[data-testid="graph-viewport"]')!.scrollTop = 50_000 * 28;
    });
    await until(async () => {
      const r = await bridge((g) => g.visibleRange());
      return r.first <= 50_000 && r.last >= 50_000;
    }, { message: 'line 50 000 visible' });
    await until(async () => (await countOf('graph-row', { index: 50_000, loaded: 'true' })) === 1, { message: "line 50,000 loaded" });
    await idle();

    const pages = await bridge((g) => g.pages());
    expect(pages.length).toBeLessThanOrEqual(6);
    expect(pages.some((p) => p.start <= 50_000 && p.end > 50_000)).toBe(true);
    expect(await countOf('graph-row')).toBe(pool); // pool of recycled lines: constant
    expect(await browser.execute(() => (window as unknown as { __mut: number }).__mut)).toBe(0);
    // Only the necessary pages were requested (End: 1 to 2 pages; jump: 1 to 3 pages with preload).
    expect((await bridge((g) => g.pageRequests())).total - requestsBefore).toBeLessThanOrEqual(8);
  });
});
