// Data manufacturers for graph tests (pages, lines, labels). No DOM dependence.
import type { GraphRow, LogPage, RefLabel } from '$lib/ipc/types';

export const hex = (n: number): string => n.toString(16).padStart(40, '0');

export function row(n: number, over: Partial<GraphRow> = {}): GraphRow {
  return {
    oid: hex(n), parents: [hex(n + 1)], summary: `commit ${n}`, author: 0, time: 1_700_000_000 - n * 60, refs: [], lane: 0, color: 0,
    kind: 'commit', stashIndex: null, shallow: false, edges: [0, 0, 0, 0, 0, 0, 0, 1], ...over,
  };
}

/** Page of `count` lines from row `start` (Oid = row); `cursor`: cursor from next page (`null` = end). */
export function page(start: number, count: number, over: Partial<LogPage> = {}): LogPage {
  return {
    rows: Array.from({ length: count }, (_, i) => row(start + i)),
    authors: [{ name: 'Alice Martin', email: 'alice@example.org' }],
    start, total: null, nextCursor: `1:${start + count}`, epoch: 1, maxLanes: 1, missing: [], ...over,
  };
}

export const label = (name: string, kind: RefLabel['kind'], isHead = false): RefLabel => ({
  name, kind, isHead,
  fullRef: kind === "local" ? `refs/heads/${name}` : kind === 'remote' ? `refs/remotes/${name}` : kind === 'tag' ? `refs/tags/${name}` : 'HEAD',
});
