// Branch slider ref → ref : state machine PURE (Pointer Events, never HTML5 DnD) and input calculation
// The effects (phantom, pointer capture, auto scrolling) are in `dnd-controller.ts`.

/** Moving threshold (px) before a support becomes a drag. */
export const DRAG_THRESHOLD = 4;
/** Distance to the edge of the graph (px) under which the automatic scrolling starts. */
export const EDGE_ZONE = 40;
export const MAX_AUTOSCROLL = 24;

export interface DragRef {
  /** `refs/heads/feature` ou `refs/remotes/origin/feature`. */
  fullRef: string;
  kind: "local" | 'remote';
  /** Short name: `feature` or `origin/feature` (the IPC commands). */
  name: string;
}

/** Local or remote branch of a complete ref; `null` for a tag, HEAD or other (no source or target). */
export function parseDragRef(fullRef: string | null | undefined): DragRef | null {
  if (!fullRef) return null;
  if (fullRef.startsWith('refs/heads/') && fullRef.length > 'refs/heads/'.length) {
    return { fullRef, kind: "local", name: fullRef.slice('refs/heads/'.length) };
  }
  if (fullRef.startsWith('refs/remotes/') && fullRef.length > 'refs/remotes/'.length && !fullRef.endsWith('/HEAD')) {
    return { fullRef, kind: 'remote', name: fullRef.slice('refs/remotes/'.length) };
  }
  return null;
}

/** Drag does not start if a script is in flight or if a status operation is in progress. */
export function canStartDrag(o: { busy: boolean; opInProgress: boolean }): boolean {
  return !o.busy && !o.opInProgress;
}

export function exceedsThreshold(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= DRAG_THRESHOLD;
}

/** A valid target is another branch (local or remote). */
export function isValidTarget(src: DragRef, dst: DragRef | null): dst is DragRef {
  return dst !== null && dst.fullRef !== src.fullRef;
}

export interface DropOptions {
  rebase: boolean;
  merge: boolean;
  /** No action applicable: `graph-drop-menu-empty` + Cancel. */
  none: boolean;
}

/**
 * repository menu entries: "Rebase `src` on `dst`" if `src` is local; "Merge `src` in `dst`" if `dst` is
 * local ET is the current branch. In HEAD removed only the rebase input can appeal.
 */
export function dropOptions(src: DragRef, dst: DragRef, head: { branch: string | null; detached: boolean }): DropOptions {
  const rebase = src.kind === "local";
  const merge = dst.kind === "local" && !head.detached && head.branch !== null && head.branch === dst.name;
  return { rebase, merge, none: !rebase && !merge };
}

/** Automatic scroll speed (px/frame, negative up) when the pointer is near a edge, proportional. */
export function autoScrollSpeed(y: number, top: number, bottom: number): number {
  if (y < top + EDGE_ZONE) return -Math.ceil((MAX_AUTOSCROLL * Math.min(EDGE_ZONE, top + EDGE_ZONE - y)) / EDGE_ZONE);
  if (y > bottom - EDGE_ZONE) return Math.ceil((MAX_AUTOSCROLL * Math.min(EDGE_ZONE, y - (bottom - EDGE_ZONE))) / EDGE_ZONE);
  return 0;
}

// - - - State machine
export type DragState =
  | { phase: 'idle' }
  | { phase: 'pressed'; src: DragRef; pointerId: number; x0: number; y0: number }
  | { phase: 'dragging'; src: DragRef; pointerId: number; x: number; y: number; target: DragRef | null }
  /** Released on a valid target: the repository menu opens in (x, y). */
  | { phase: 'dropped'; src: DragRef; dst: DragRef; x: number; y: number };

export const IDLE: DragState = { phase: 'idle' };

export function press(s: DragState, src: DragRef, pointerId: number, x: number, y: number, allowed: boolean): DragState {
  if (!allowed || s.phase === 'pressed' || s.phase === 'dragging') return s;
  return { phase: 'pressed', src, pointerId, x0: x, y0: y };
}

/** `targetAt`: target under pointer (already solved by controller), `null` off target. */
export function move(s: DragState, pointerId: number, x: number, y: number, targetAt: DragRef | null): DragState {
  if (s.phase === 'pressed' && s.pointerId === pointerId) {
    if (!exceedsThreshold(x - s.x0, y - s.y0)) return s;
    return { phase: 'dragging', src: s.src, pointerId, x, y, target: isValidTarget(s.src, targetAt) ? targetAt : null };
  }
  if (s.phase === 'dragging' && s.pointerId === pointerId) {
    return { ...s, x, y, target: isValidTarget(s.src, targetAt) ? targetAt : null };
  }
  return s;
}

/** Release: a support without drag is just a click (return to `idle`); a repository without target cancels without effect. */
export function release(s: DragState, pointerId: number, x: number, y: number, targetAt: DragRef | null): DragState {
  if (s.phase === 'pressed' && s.pointerId === pointerId) return IDLE;
  if (s.phase === 'dragging' && s.pointerId === pointerId) {
    return isValidTarget(s.src, targetAt) ? { phase: 'dropped', src: s.src, dst: targetAt, x, y } : IDLE;
  }
  return s;
}

/** Escape, loss of capture or cancellation of pointer. */
export function cancel(s: DragState): DragState {
  return s.phase === 'pressed' || s.phase === 'dragging' ? IDLE : s;
}

export const isDragging = (s: DragState): boolean => s.phase === 'dragging';
