// Commits not reachable from HEAD (04 "Overview and Selection": text at 0.75 opacity, `graph.dimUnreachable` setting).
// The log is topological (child before parent): only one passage from top to bottom is enough. We keep the "border": the oids
// expected because a commit A person who can be reached has them as his parent. commit is reachable if it is HEAD or at the border.
//
// The passage can only be made from line 0: only the adjacent pages from the top are classified.
// (after a distant jump) are "unknown" and are not faded. Flags are worn by the line object (WeakMap):
// they disappear with the freed pages.
import type { GraphRow, LogPage } from '$lib/ipc/types';
import { pageEnd } from './pages';

export class Reachability {
  #flags = new WeakMap<GraphRow, boolean>();
  #frontier = new Set<string>();
  #end = 0;
  #epoch = -1;
  #head: string | null = null;

  /** Classifies adjacent pages from line 0 (takes where the last passage had stopped). Reset to zero if epoch or HEAD changes. */
  feed(pages: readonly LogPage[], headOid: string | null, epoch: number): void {
    if (epoch !== this.#epoch || headOid !== this.#head) {
      this.#epoch = epoch;
      this.#head = headOid;
      this.#frontier = new Set(headOid ? [headOid] : []);
      this.#end = 0;
    }
    if (!headOid) return;
    for (;;) {
      const page = pages.find((p) => p.start <= this.#end && pageEnd(p) > this.#end);
      if (!page) return;
      for (let r = this.#end; r < pageEnd(page); r++) this.#classify(page.rows[r - page.start]!);
      this.#end = pageEnd(page);
    }
  }

  #classify(row: GraphRow): void {
    if (row.kind === 'stash') {
      this.#flags.set(row, true); // pseudo-commit: Never faded, doesn't propagate anything
      return;
    }
    const reachable = this.#frontier.delete(row.oid);
    this.#flags.set(row, reachable);
    if (reachable) for (const p of row.parents) this.#frontier.add(p);
  }

  /** `false` only if the line is classified "out of line HEAD"; an unknown line is never blurred. */
  isReachable(row: GraphRow): boolean {
    return this.#flags.get(row) !== false;
  }

  /** Number of lines classified from the top (diagnosis, tests). */
  get classifiedEnd(): number {
    return this.#end;
  }
}
