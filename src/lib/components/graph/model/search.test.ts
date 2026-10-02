import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogMatch, LogSearchResult } from '$lib/ipc/types';
import { SEARCH_DEBOUNCE_MS, SearchEngine, countLabel, cycleIndex } from './search.svelte';

const m = (n: number): LogMatch => ({ oid: n.toString(16).padStart(40, '0'), row: n });
const result = (n: number, truncated = false): LogSearchResult => ({ matches: Array.from({ length: n }, (_, i) => m(i * 3)), truncated });

function setup(search: (q: string, limit: number) => Promise<LogSearchResult>) {
  const go = vi.fn<(x: LogMatch) => void>();
  let current: string | null = null;
  const onError = vi.fn();
  const engine = new SearchEngine({ search, go: (x) => { current = x.oid; go(x); }, currentOid: () => current, onError });
  return { engine, go, onError };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("metering and navigation", () => {
  it('« 3 / 42 », « 1 / 1000+ », « 0 / 0 »', () => {
    expect(countLabel(2, 42, false)).toBe('3 / 42');
    expect(countLabel(0, 1000, true)).toBe('1 / 1000+');
    expect(countLabel(-1, 0, false)).toBe('0 / 0');
  });
  it("Next / previous closure", () => {
    expect(cycleIndex(2, 3, 1)).toBe(0);
    expect(cycleIndex(0, 3, -1)).toBe(2);
    expect(cycleIndex(-1, 3, 1)).toBe(0);
    expect(cycleIndex(-1, 3, -1)).toBe(2);
    expect(cycleIndex(0, 0, 1)).toBe(-1);
  });
});

describe('recherche', () => {
  it("drop of 150 ms, then limit 50; the first result is selected", async () => {
    const search = vi.fn().mockResolvedValue(result(1));
    const { engine, go } = setup(search);
    engine.input('commit 7');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1);
    expect(search).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith('commit 7', 50);
    await vi.advanceTimersByTimeAsync(0);
    expect(go).toHaveBeenCalledWith(m(0));
    expect(engine.label).toBe('1 / 1');
    expect(engine.empty).toBe(false);
  });

  it("Untruncated result: one call (the first one is enough)", async () => {
    const search = vi.fn().mockResolvedValue(result(3, false));
    const { engine } = setup(search);
    engine.input('sha:abcd');
    await vi.advanceTimersByTimeAsync(400);
    expect(search).toHaveBeenCalledTimes(1);
    expect(engine.label).toBe('1 / 3');
  });

  it("Truncated result: second call limit 1000 which replaces the first and keeps the position (current oid)", async () => {
    const full = { matches: [m(100), m(0), m(3), m(6)], truncated: false };
    const search = vi.fn().mockResolvedValueOnce(result(2, true)).mockResolvedValueOnce(full);
    const { engine, go } = setup(search);
    engine.input('msg:fix');
    await vi.advanceTimersByTimeAsync(400);
    expect(search.mock.calls.map((c) => c[1])).toEqual([50, 1000]);
    expect(go).toHaveBeenCalledTimes(1); // only the first result is selected, not the full result
    expect(engine.matches).toEqual(full.matches);
    expect(engine.index).toBe(1); // m(0), the selected oid, is now in 2nd position
    expect(engine.label).toBe('2 / 4');
  });

  it("1 / 1000+ if the complete list is itself truncated", async () => {
    const search = vi.fn().mockResolvedValue({ matches: Array.from({ length: 1000 }, (_, i) => m(i)), truncated: true });
    const { engine } = setup(search);
    engine.input('a');
    await vi.advanceTimersByTimeAsync(400);
    expect(engine.label).toBe('1 / 1000+');
  });

  it("Entry / Shift+Entry: next and previous, with closure, and result selection", async () => {
    const { engine, go } = setup(vi.fn().mockResolvedValue(result(3)));
    engine.input('x');
    await vi.advanceTimersByTimeAsync(400);
    engine.next();
    expect(go).toHaveBeenLastCalledWith(m(3));
    engine.next();
    engine.next();
    expect(engine.index).toBe(0);
    engine.prev();
    expect(engine.index).toBe(2);
    expect(go).toHaveBeenLastCalledWith(m(6));
  });

  it("no result : 0 / 0 and data-empty-result", async () => {
    const { engine, go } = setup(vi.fn().mockResolvedValue(result(0)));
    engine.input('zzz');
    await vi.advanceTimersByTimeAsync(400);
    expect(engine.label).toBe('0 / 0');
    expect(engine.empty).toBe(true);
    expect(go).not.toHaveBeenCalled();
    engine.next();
    expect(go).not.toHaveBeenCalled();
  });

  it("a new keystroke renders the previous answer null and void (request ID)", async () => {
    let resolveFirst!: (r: LogSearchResult) => void;
    const search = vi
      .fn()
      .mockImplementationOnce(() => new Promise<LogSearchResult>((r) => (resolveFirst = r)))
      .mockResolvedValueOnce(result(2));
    const { engine, go } = setup(search);
    engine.input('a');
    await vi.advanceTimersByTimeAsync(200); // 1st flight request
    engine.input('ab');
    await vi.advanceTimersByTimeAsync(200);
    expect(go).toHaveBeenCalledTimes(1);
    resolveFirst(result(5)); // late response of 'a': ignored
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.matches).toHaveLength(2);
    expect(engine.query).toBe('ab');
  });

  it("erase field erases results without call", async () => {
    const search = vi.fn().mockResolvedValue(result(2));
    const { engine } = setup(search);
    engine.input('a');
    await vi.advanceTimersByTimeAsync(400);
    engine.input('');
    expect(engine.matches).toEqual([]);
    expect(engine.index).toBe(-1);
    await vi.advanceTimersByTimeAsync(400);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("restore (new epoch) restarts without moving the selection", async () => {
    const search = vi.fn().mockResolvedValue(result(3));
    const { engine, go } = setup(search);
    engine.input('x');
    await vi.advanceTimersByTimeAsync(400);
    engine.next(); // select m(3)
    go.mockClear();
    engine.restart();
    await vi.advanceTimersByTimeAsync(0);
    expect(search).toHaveBeenCalledTimes(2);
    expect(go).not.toHaveBeenCalled();
    expect(engine.index).toBe(1);
  });

  it("close: flight queries ignored, reset to zero", async () => {
    let resolve!: (r: LogSearchResult) => void;
    const search = vi.fn().mockImplementation(() => new Promise<LogSearchResult>((r) => (resolve = r)));
    const { engine, go } = setup(search);
    engine.input('a');
    await vi.advanceTimersByTimeAsync(200);
    engine.close();
    resolve(result(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(go).not.toHaveBeenCalled();
    expect(engine.query).toBe('');
    expect(engine.matches).toEqual([]);
  });

  it("a backend error has gone up", async () => {
    const err = new Error('boom');
    const { engine, onError } = setup(vi.fn().mockRejectedValue(err));
    engine.input('a');
    await vi.advanceTimersByTimeAsync(400);
    expect(onError).toHaveBeenCalledWith(err);
    expect(engine.searching).toBe(false);
  });
});
