import { describe, expect, it } from 'vitest';
import { fileDiff, hunk } from '../wt/__tests__/helpers';
import { changeIndexes, extendSelection, pickLine, selectedLines } from './line-select';

// hunk 0: ctx(0) del(1) del(2) add(3) add(4) ctx(5) add(6) noeol(7); hunk 1: ctx(0) del(1) add(2)
const { hunks } = fileDiff({
  hunks: [
    hunk([['ctx', 'a', 1, 1], ['del', 'b', 2, null], ['del', 'c', 3, null], ['add', 'B', null, 2], ['add', 'C', null, 3], ['ctx', 'd', 4, 4], ['add', 'e', null, 5], ['noeol', '\\ No newline at end of file', null, null]]),
    hunk([['ctx', 'x', 10, 10], ['del', 'y', 11, null], ['add', 'Y', null, 11]]),
  ],
});

describe('changeIndexes', () => {
  it("only the added and removed lines, in order", () => {
    expect(changeIndexes(hunks[0])).toEqual([1, 2, 3, 4, 6]);
    expect(changeIndexes(hunks[1])).toEqual([1, 2]);
    expect(changeIndexes(undefined)).toEqual([]);
  });
});

describe('pickLine (mouse)', () => {
  it("a plain pick selects one line and makes it the anchor", () => {
    const sel = pickLine(null, hunks, 0, 2);
    expect(selectedLines(sel)).toEqual([2]);
    expect(sel).toMatchObject({ hunk: 0, anchor: 2, focus: 2 });
  });

  it("context lines and the no-newline marker cannot be picked: the selection is unchanged", () => {
    const sel = pickLine(null, hunks, 0, 1);
    expect(pickLine(sel, hunks, 0, 0)).toBe(sel);
    expect(pickLine(sel, hunks, 0, 5)).toBe(sel);
    expect(pickLine(sel, hunks, 0, 7)).toBe(sel);
    expect(pickLine(null, hunks, 0, 0)).toBeNull();
    expect(pickLine(sel, hunks, 5, 0)).toBe(sel);
    expect(pickLine(sel, hunks, 0, 99)).toBe(sel);
  });

  it("toggle adds and removes lines of the same hunk; removing the last one clears the selection", () => {
    let sel = pickLine(null, hunks, 0, 1, { toggle: true });
    sel = pickLine(sel, hunks, 0, 4, { toggle: true });
    expect(selectedLines(sel)).toEqual([1, 4]);
    expect(sel).toMatchObject({ anchor: 4, focus: 4 });
    sel = pickLine(sel, hunks, 0, 1, { toggle: true });
    expect(selectedLines(sel)).toEqual([4]);
    expect(pickLine(sel, hunks, 0, 4, { toggle: true })).toBeNull();
  });

  it("a line of another hunk starts a new selection there", () => {
    const sel = pickLine(pickLine(null, hunks, 0, 1), hunks, 1, 2, { toggle: true });
    expect(sel).toMatchObject({ hunk: 1, anchor: 2, focus: 2 });
    expect(selectedLines(sel)).toEqual([2]);
    expect(selectedLines(pickLine(pickLine(null, hunks, 0, 1), hunks, 1, 1, { shift: true }))).toEqual([1]);
  });

  it("shift selects the changes between the anchor and the line, skipping context, in both directions", () => {
    const start = pickLine(null, hunks, 0, 2);
    const down = pickLine(start, hunks, 0, 6, { shift: true });
    expect(selectedLines(down)).toEqual([2, 3, 4, 6]);
    expect(down).toMatchObject({ anchor: 2, focus: 6 });
    const up = pickLine(start, hunks, 0, 1, { shift: true });
    expect(selectedLines(up)).toEqual([1, 2]);
    // The range is measured from the anchor again, not from the last end.
    expect(selectedLines(pickLine(down, hunks, 0, 3, { shift: true }))).toEqual([2, 3]);
  });

  it("shift without a selection behaves like a plain pick", () => {
    expect(selectedLines(pickLine(null, hunks, 0, 3, { shift: true }))).toEqual([3]);
  });

  it("shift + toggle adds the range to what is already selected", () => {
    let sel = pickLine(null, hunks, 0, 1);
    sel = pickLine(sel, hunks, 0, 6, { toggle: true });
    sel = pickLine(sel, hunks, 0, 3, { shift: true, toggle: true });
    expect(selectedLines(sel)).toEqual([1, 3, 4, 6]);
  });
});

describe('extendSelection (keyboard)', () => {
  it("starts on the first change going down, on the last going up", () => {
    expect(selectedLines(extendSelection(null, hunks, 0, 1))).toEqual([1]);
    expect(selectedLines(extendSelection(null, hunks, 0, -1))).toEqual([6]);
    expect(extendSelection(null, hunks, 1, 1)).toMatchObject({ hunk: 1, anchor: 1, focus: 1 });
  });

  it("each step moves the focus to the next change and keeps the anchor", () => {
    let sel = extendSelection(null, hunks, 0, 1);
    sel = extendSelection(sel, hunks, 0, 1);
    sel = extendSelection(sel, hunks, 0, 1);
    expect(selectedLines(sel)).toEqual([1, 2, 3]);
    expect(sel).toMatchObject({ anchor: 1, focus: 3 });
    // Going back shrinks the range, going past the anchor flips it.
    sel = extendSelection(sel, hunks, 0, -1);
    expect(selectedLines(sel)).toEqual([1, 2]);
    sel = extendSelection(extendSelection(sel, hunks, 0, -1), hunks, 0, -1);
    expect(selectedLines(sel)).toEqual([1]);
  });

  it("stops at the ends of the hunk and never leaves it", () => {
    let sel = extendSelection(null, hunks, 1, 1);
    sel = extendSelection(sel, hunks, 1, 1);
    expect(selectedLines(sel)).toEqual([1, 2]);
    expect(selectedLines(extendSelection(sel, hunks, 1, 1))).toEqual([1, 2]);
    expect(selectedLines(extendSelection(extendSelection(null, hunks, 0, -1), hunks, 0, -1))).toEqual([4, 6]);
  });

  it("a hunk without change leaves the selection as it is", () => {
    const flat = fileDiff({ hunks: [hunk([['ctx', 'a', 1, 1]])] }).hunks;
    expect(extendSelection(null, flat, 0, 1)).toBeNull();
    expect(extendSelection(null, [], 0, 1)).toBeNull();
  });
});

describe('selectedLines', () => {
  it("ascending whatever the order of the picks; empty without selection", () => {
    let sel = pickLine(null, hunks, 0, 6);
    sel = pickLine(sel, hunks, 0, 1, { toggle: true });
    expect(selectedLines(sel)).toEqual([1, 6]);
    expect(selectedLines(null)).toEqual([]);
  });
});
