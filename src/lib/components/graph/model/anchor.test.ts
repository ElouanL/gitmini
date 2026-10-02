import { describe, expect, it } from 'vitest';
import { captureAnchor, restoreAnchor } from './anchor';
import { ROW_H } from './geometry';

const commit = (row: number) => ({ oid: `o${row}`, row });

describe("oid scroll anchor", () => {
  it("captures the first visible commit and the offset in pixels", () => {
    const a = captureAnchor(10 * ROW_H + 9, 0, (r) => commit(r));
    expect(a).toEqual({ oid: 'o10', offset: 9, top: false });
  });
  it("with the line WIP, the actual row is shifted from a line", () => {
    const a = captureAnchor(10 * ROW_H, 1, (r) => commit(r));
    expect(a.oid).toBe('o9');
    expect(a.offset).toBe(0);
  });
  it("top: anchor stays at the top (a new commit appears at the top)", () => {
    const a = captureAnchor(0, 0, (r) => commit(r));
    expect(a.top).toBe(true);
    expect(restoreAnchor(a, 0, () => 50)).toBe(0);
  });
  it("restores to the new position of the same oid, at the same time", () => {
    const a = captureAnchor(10 * ROW_H + 9, 0, (r) => commit(r));
    expect(restoreAnchor(a, 0, (oid) => (oid === 'o10' ? 13 : -1))).toBe(13 * ROW_H + 9);
    expect(restoreAnchor(a, 1, (oid) => (oid === 'o10' ? 13 : -1))).toBe(14 * ROW_H + 9);
  });
  it('oid disparu : null (l’appelant revient en haut)', () => {
    const a = captureAnchor(500, 0, (r) => commit(r));
    expect(restoreAnchor(a, 0, () => -1)).toBeNull();
  });
  it("nothing loaded: no anchor", () => {
    const a = captureAnchor(500, 0, () => null);
    expect(a.oid).toBeNull();
    expect(restoreAnchor(a, 0, () => 3)).toBeNull();
  });
});
