import { describe, expect, it } from 'vitest';
import { hex, page, row } from '../test-utils';
import { Reachability } from './reach';

describe("commits out of line HEAD", () => {
  it("class of one passage: HEAD and its forefathers reachable, the rest not", () => {
    // 0 (other branch, above from HEAD); 1 = HEAD → 2 → 4; 3 (other branch) → 4
    const rows = [
      row(0, { parents: [hex(4)] }),
      row(1, { parents: [hex(2)] }),
      row(2, { parents: [hex(4)] }),
      row(3, { parents: [hex(4)] }),
      row(4, { parents: [] }),
    ];
    const reach = new Reachability();
    const p = page(0, 0, { rows });
    reach.feed([p], hex(1), 1);
    expect(rows.map((r) => reach.isReachable(r))).toEqual([false, true, true, false, true]);
    expect(reach.classifiedEnd).toBe(5);
  });

  it('un merge propage aux deux parents', () => {
    const rows = [row(1, { parents: [hex(2), hex(3)] }), row(2, { parents: [hex(4)] }), row(3, { parents: [hex(4)] }), row(4, { parents: [] })];
    const reach = new Reachability();
    reach.feed([page(0, 0, { rows })], hex(1), 1);
    expect(rows.every((r) => reach.isReachable(r))).toBe(true);
  });

  it("a line of stash is never blurred and does not propagate anything", () => {
    const rows = [row(9, { kind: 'stash', stashIndex: 0, parents: [hex(1)] }), row(1, { parents: [] })];
    const reach = new Reachability();
    reach.feed([page(0, 0, { rows })], hex(1), 1);
    expect(reach.isReachable(rows[0]!)).toBe(true);
    expect(reach.isReachable(rows[1]!)).toBe(true);
  });

  it("only adjacent pages from the top are classified; other lines are not blurred", () => {
    const first = page(0, 3);
    const far = page(5000, 3);
    const reach = new Reachability();
    reach.feed([first, far], hex(0), 1);
    expect(reach.classifiedEnd).toBe(3);
    expect(reach.isReachable(far.rows[0]!)).toBe(true); // unknown = never faded
    // When the missing page arrives, the passage resumes where it had stopped
    const gap = page(3, 4997, { rows: Array.from({ length: 4997 }, (_, i) => row(3 + i)) });
    reach.feed([first, gap, far], hex(0), 1);
    expect(reach.classifiedEnd).toBe(5003);
  });

  it("a new epoch or another HEAD returns from zero", () => {
    const rows = [row(0, { parents: [hex(1)] }), row(1, { parents: [] })];
    const p = page(0, 0, { rows });
    const reach = new Reachability();
    reach.feed([p], hex(1), 1);
    expect(reach.isReachable(rows[0]!)).toBe(false); // above de HEAD
    reach.feed([p], hex(0), 2);
    expect(reach.isReachable(rows[0]!)).toBe(true);
  });

  it("Without HEAD (repository empty) nothing is blurred", () => {
    const rows = [row(0)];
    const reach = new Reachability();
    reach.feed([page(0, 0, { rows })], null, 1);
    expect(reach.isReachable(rows[0]!)).toBe(true);
  });
});
