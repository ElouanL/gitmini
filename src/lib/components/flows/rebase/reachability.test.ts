import { describe, expect, it } from 'vitest';
import { reachableFromHead, type ParentsRow } from './reachability';

// m3 - m2 - m1 (HEAD = f2) : f2 → f1 → m1 ; side commit s1 (parent m1) outside HEAD
const rows = new Map<string, ParentsRow>([
  ['f2', { parents: ['f1'] }],
  ['f1', { parents: ['m1'] }],
  ['m1', { parents: [] }],
  ['s1', { parents: ['m1'] }],
]);

describe('reachableFromHead', () => {
  it("ancestor of HEAD (including HEAD)", () => {
    expect(reachableFromHead('f2', 'f2', rows)).toBe('yes');
    expect(reachableFromHead('f2', 'm1', rows)).toBe('yes');
  });
  it("Full history loaded: a commit out of HEAD is definitely unreachable", () => {
    expect(reachableFromHead('f2', 's1', rows)).toBe('no');
  });
  it("Truncated historical: unknown response (entry remains visible)", () => {
    const partial = new Map<string, ParentsRow>([['f2', { parents: ['f1'] }]]);
    expect(reachableFromHead('f2', 'zz', partial)).toBe('unknown');
    expect(reachableFromHead('f2', 'f1', partial)).toBe('yes');
  });
  it("HEAD unknown : unknown ; merges : follows all parents", () => {
    expect(reachableFromHead(null, 'm1', rows)).toBe('unknown');
    const merge = new Map<string, ParentsRow>([
      ['h', { parents: ['a', 'b'] }], ['a', { parents: [] }], ['b', { parents: [] }],
    ]);
    expect(reachableFromHead('h', 'b', merge)).toBe('yes');
  });
});
