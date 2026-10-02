import { describe, expect, it } from 'vitest';
import { clickSelect, EMPTY_SELECTION, keyboardTargets, moveFocus, neighborAfterRemoval, prune, targetsFor } from './selection';

const order = ['a', 'b', 'c', 'd', 'e'];

describe('clickSelect', () => {
  it("simple click: unique selection", () => {
    const s = clickSelect(EMPTY_SELECTION, order, 'c');
    expect([...s.paths]).toEqual(['c']);
    expect(s.anchor).toBe('c');
    expect(s.focus).toBe('c');
  });

  it("Mod+click adds and removes", () => {
    let s = clickSelect(EMPTY_SELECTION, order, 'a');
    s = clickSelect(s, order, 'c', { toggle: true });
    expect([...s.paths].sort()).toEqual(['a', 'c']);
    s = clickSelect(s, order, 'a', { toggle: true });
    expect([...s.paths]).toEqual(['c']);
  });

  it("Shift+click: beach from anchor, in both directions", () => {
    let s = clickSelect(EMPTY_SELECTION, order, 'b');
    s = clickSelect(s, order, 'd', { shift: true });
    expect([...s.paths].sort()).toEqual(['b', 'c', 'd']);
    expect(s.anchor).toBe('b');
    s = clickSelect(s, order, 'a', { shift: true });
    expect([...s.paths].sort()).toEqual(['a', 'b']);
  });

  it("Shift+click without valid anchor behaves like a simple click", () => {
    const s = clickSelect({ paths: new Set(['x']), anchor: 'x', focus: 'x' }, order, 'c', { shift: true });
    expect([...s.paths]).toEqual(['c']);
  });
});

describe('moveFocus', () => {
  it("Down, up, bounded, Start / End", () => {
    let s = moveFocus(EMPTY_SELECTION, order, 1);
    expect(s.focus).toBe('a');
    s = moveFocus(s, order, 1);
    expect(s.focus).toBe('b');
    s = moveFocus(s, order, 'end');
    expect(s.focus).toBe('e');
    s = moveFocus(s, order, 1);
    expect(s.focus).toBe('e');
    s = moveFocus(s, order, 'home');
    expect(s.focus).toBe('a');
    s = moveFocus(s, order, -1);
    expect(s.focus).toBe('a');
  });

  it("since nothing, ↑ goes to the last", () => {
    expect(moveFocus(EMPTY_SELECTION, order, -1).focus).toBe('e');
  });

  it("Shift+arrow expands selection", () => {
    let s = moveFocus(EMPTY_SELECTION, order, 'home');
    s = moveFocus(s, order, 1, true);
    s = moveFocus(s, order, 1, true);
    expect([...s.paths].sort()).toEqual(['a', 'b', 'c']);
  });

  it("empty list: unchanged status", () => {
    expect(moveFocus(EMPTY_SELECTION, [], 1)).toBe(EMPTY_SELECTION);
  });
});

describe("targets and cleaning", () => {
  it("an action from a selection line targets the whole selection, otherwise the line alone", () => {
    const s = clickSelect(clickSelect(EMPTY_SELECTION, order, 'b'), order, 'd', { toggle: true });
    expect(targetsFor(s, order, 'd')).toEqual(['b', 'd']);
    expect(targetsFor(s, order, 'a')).toEqual(['a']);
  });

  it("the keyboard is aimed at selection, otherwise the focused file", () => {
    expect(keyboardTargets({ paths: new Set(), anchor: null, focus: 'c' }, order)).toEqual(['c']);
    expect(keyboardTargets({ paths: new Set(['e', 'a']), anchor: 'a', focus: 'a' }, order)).toEqual(['a', 'e']);
    expect(keyboardTargets(EMPTY_SELECTION, order)).toEqual([]);
  });

  it("plum removes missing paths", () => {
    const s = prune({ paths: new Set(['a', 'x']), anchor: 'x', focus: 'a' }, order);
    expect([...s.paths]).toEqual(['a']);
    expect(s.anchor).toBeNull();
    expect(s.focus).toBe('a');
    const same = { paths: new Set(['a']), anchor: 'a', focus: 'a' };
    expect(prune(same, order)).toBe(same);
  });

  it("After a file placement, the focus goes to the next, if not the previous one.", () => {
    expect(neighborAfterRemoval(order, ['a', 'c', 'd', 'e'], ['b'])).toBe('c');
    expect(neighborAfterRemoval(order, ['a', 'b', 'c', 'd'], ['e'])).toBe('d');
    expect(neighborAfterRemoval(order, [], order)).toBeNull();
  });
});
