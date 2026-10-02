import { describe, expect, it } from 'vitest';
import {
  DRAG_THRESHOLD, EDGE_ZONE, IDLE, MAX_AUTOSCROLL, autoScrollSpeed, cancel, canStartDrag, dropOptions, exceedsThreshold, isDragging, isValidTarget, move,
  parseDragRef, press, release, type DragRef,
} from './dnd';

const local = (n: string): DragRef => ({ fullRef: `refs/heads/${n}`, kind: "local", name: n });
const remote = (n: string): DragRef => ({ fullRef: `refs/remotes/${n}`, kind: 'remote', name: n });

describe("slider references", () => {
  it("local and remote branches only, short names", () => {
    expect(parseDragRef('refs/heads/feature/x')).toEqual({ fullRef: 'refs/heads/feature/x', kind: "local", name: 'feature/x' });
    expect(parseDragRef('refs/remotes/origin/main')).toEqual({ fullRef: 'refs/remotes/origin/main', kind: 'remote', name: 'origin/main' });
    expect(parseDragRef('refs/tags/v1')).toBeNull();
    expect(parseDragRef('HEAD')).toBeNull();
    expect(parseDragRef('refs/remotes/origin/HEAD')).toBeNull();
    expect(parseDragRef(null)).toBeNull();
    expect(parseDragRef('refs/heads/')).toBeNull();
  });
  it("a valid target is a AUTRE branch", () => {
    expect(isValidTarget(local('a'), local('b'))).toBe(true);
    expect(isValidTarget(local('a'), local('a'))).toBe(false);
    expect(isValidTarget(local('a'), null)).toBe(false);
  });
});

describe("start", () => {
  it("does not start during a write-up or a state-of-the-art operation", () => {
    expect(canStartDrag({ busy: false, opInProgress: false })).toBe(true);
    expect(canStartDrag({ busy: true, opInProgress: false })).toBe(false);
    expect(canStartDrag({ busy: false, opInProgress: true })).toBe(false);
  });
  it('seuil de 4 px', () => {
    expect(DRAG_THRESHOLD).toBe(4);
    expect(exceedsThreshold(3, 0)).toBe(false);
    expect(exceedsThreshold(3, 3)).toBe(true);
  });
});

describe("state machine", () => {
  it("press → drag after 4 px → repository on a valid target", () => {
    let s = press(IDLE, local('feature'), 1, 100, 100, true);
    expect(s.phase).toBe('pressed');
    s = move(s, 1, 102, 101, null);
    expect(s.phase).toBe('pressed'); // below threshold
    s = move(s, 1, 130, 100, local('main'));
    expect(s).toMatchObject({ phase: 'dragging', target: local('main') });
    s = move(s, 1, 140, 100, local('feature')); // the source is not a target
    expect(s).toMatchObject({ phase: 'dragging', target: null });
    s = move(s, 1, 150, 100, local('main'));
    const dropped = release(s, 1, 150, 100, local('main'));
    expect(dropped).toEqual({ phase: 'dropped', src: local('feature'), dst: local('main'), x: 150, y: 100 });
  });
  it("release off target cancels without effect; a single click is not a drag", () => {
    let s = press(IDLE, local('a'), 1, 0, 0, true);
    expect(release(s, 1, 1, 1, null)).toEqual(IDLE);
    s = move(s, 1, 50, 0, null);
    expect(release(s, 1, 50, 0, null)).toEqual(IDLE);
  });
  it("Escape / loss of pointer cancel", () => {
    let s = press(IDLE, local('a'), 1, 0, 0, true);
    s = move(s, 1, 50, 0, remote('origin/b'));
    expect(isDragging(s)).toBe(true);
    expect(cancel(s)).toEqual(IDLE);
    expect(cancel(IDLE)).toEqual(IDLE);
  });
  it("ignores another pointer, and unauthorized support", () => {
    const s = press(IDLE, local('a'), 1, 0, 0, true);
    expect(move(s, 2, 50, 0, null)).toBe(s);
    expect(press(IDLE, local('a'), 1, 0, 0, false)).toBe(IDLE);
  });
});

describe("repository menu", () => {
  const head = { branch: 'main', detached: false };
  it("rebase if src is local; merge if dst is local AND current", () => {
    expect(dropOptions(local('feature'), local('main'), head)).toEqual({ rebase: true, merge: true, none: false });
    expect(dropOptions(local('feature'), local('other'), head)).toEqual({ rebase: true, merge: false, none: false });
    expect(dropOptions(local('feature'), remote('origin/main'), head)).toEqual({ rebase: true, merge: false, none: false });
  });
  it("remote src: only merges in the current, if not \"no action possible\"", () => {
    expect(dropOptions(remote('origin/feature'), local('main'), head)).toEqual({ rebase: false, merge: true, none: false });
    expect(dropOptions(remote('origin/feature'), local('other'), head)).toEqual({ rebase: false, merge: false, none: true });
    expect(dropOptions(remote('origin/a'), remote('origin/b'), head).none).toBe(true);
  });
  it("HEAD detached: only rebase can be offered", () => {
    expect(dropOptions(local('feature'), local('main'), { branch: null, detached: true })).toEqual({ rebase: true, merge: false, none: false });
  });
});

describe("auto scrolling", () => {
  it("zero at centre, proportional near edges (area of 40 px)", () => {
    expect(autoScrollSpeed(300, 0, 600)).toBe(0);
    expect(autoScrollSpeed(EDGE_ZONE, 0, 600)).toBe(0);
    expect(autoScrollSpeed(20, 0, 600)).toBeLessThan(0);
    expect(autoScrollSpeed(0, 0, 600)).toBe(-MAX_AUTOSCROLL);
    expect(autoScrollSpeed(600 - 20, 0, 600)).toBeGreaterThan(0);
    expect(Math.abs(autoScrollSpeed(10, 0, 600))).toBeGreaterThan(Math.abs(autoScrollSpeed(30, 0, 600)));
    expect(autoScrollSpeed(-50, 0, 600)).toBe(-MAX_AUTOSCROLL);
  });
});
