// Branch slider ref → ref by Pointer Events — JAMAIS the API HTML5 Drag and Drop (WebDriver does not drive it)
// under WebKitGTK / WebView2, ) Document level earphones: a source is any element carrying
// `data-ref="refs/heads|remotes/…"` and one of the ci-dessous identifiers (graph label, `sidebar-branch-item`,
// `sidebar-remote-branch-item`); no sidebar cooperation is required. The state machine is in model/dnd.ts.
//
// - the slide starts after 4 px of moving button pressed; a ghost follows the cursor;
// - the pointer is captured on a stable element (the graph's viewport, whose lines are recycled);
// - automatic scrolling of the graph to less than 40 px of a edge; Escape cancels; an off-target repository has no effect;
// - does not start if a handwriting is in flight or if a state-of-the-art operation is in progress.
import { op } from '$lib/stores/op.svelte';
import { refs } from '$lib/stores/refs.svelte';
import { repo } from '$lib/stores/repo.svelte';
import { ui } from '$lib/stores/ui.svelte';
import { dnd } from './dnd.svelte';
import {
  IDLE, autoScrollSpeed, canStartDrag, cancel, isDragging, move, parseDragRef, press, release, type DragRef, type DragState,
} from './model/dnd';

const SOURCE_SELECTOR = '[data-testid="graph-ref-label"], [data-testid="sidebar-branch-item"], [data-testid="sidebar-remote-branch-item"]';
const VIEWPORT_SELECTOR = '[data-testid="graph-viewport"]';

function refOf(el: Element | null): DragRef | null {
  const src = el?.closest?.(SOURCE_SELECTOR) ?? null;
  return parseDragRef(src?.getAttribute('data-ref'));
}

export function installBranchDnd(doc: Document = document): () => void {
  let state: DragState = IDLE;
  let ghost: HTMLElement | null = null;
  let targetEl: Element | null = null;
  let captureEl: Element | null = null;
  let pointer = { x: 0, y: 0 };
  let speed = 0;
  let raf = 0;

  const targetAt = (x: number, y: number): { ref: DragRef; el: Element } | null => {
    const el = doc.elementFromPoint(x, y);
    const src = el?.closest?.(SOURCE_SELECTOR) ?? null;
    const ref = parseDragRef(src?.getAttribute('data-ref'));
    return src && ref ? { ref, el: src } : null;
  };

  const setTarget = (el: Element | null): void => {
    if (el === targetEl) return;
    targetEl?.removeAttribute('data-drop-target');
    targetEl = el;
    el?.setAttribute('data-drop-target', 'true');
  };

  const refresh = (x: number, y: number, pointerId: number): void => {
    const hit = state.phase === 'pressed' || state.phase === 'dragging' ? targetAt(x, y) : null;
    const was = state.phase;
    state = move(state, pointerId, x, y, hit?.ref ?? null);
    if (state.phase === 'dragging') {
      if (was !== 'dragging') startDrag();
      setTarget(state.target ? (hit?.el ?? null) : null);
      moveGhost();
    }
  };

  const startDrag = (): void => {
    if (state.phase !== 'dragging') return;
    // The pointer is captured only here, once he has started it: captured from the support, he would divert the `click` from a simple
    // click on a label (the target of the `click` would become the capturing element).Stable element: the lines of the graph are recycled.
    captureEl = viewportEl() ?? doc.body;
    try {
      captureEl.setPointerCapture?.(state.pointerId);
    } catch {
      /* synthetic pointer without possible capture: the headphones of the document are sufficient */
    }
    ghost = doc.createElement('div');
    ghost.className = 'gr-ghost';
    ghost.setAttribute('data-testid', 'graph-drag-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.textContent = state.src.name;
    doc.body.appendChild(ghost);
    doc.documentElement.classList.add('gr-dragging');
    tickAutoScroll();
  };

  const moveGhost = (): void => {
    if (ghost) ghost.style.transform = `translate(${pointer.x + 12}px, ${pointer.y + 12}px)`;
  };

  const viewportEl = (): HTMLElement | null => doc.querySelector<HTMLElement>(VIEWPORT_SELECTOR);

  const tickAutoScroll = (): void => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!isDragging(state)) return;
      const vp = viewportEl();
      if (vp) {
        const r = vp.getBoundingClientRect();
        speed = pointer.x >= r.left && pointer.x <= r.right ? autoScrollSpeed(pointer.y, r.top, r.bottom) : 0;
        if (speed !== 0) {
          vp.scrollTop += speed;
          // The content scrolls under the pointer: the target is changing without moving.
          if (state.phase === 'dragging') refresh(pointer.x, pointer.y, state.pointerId);
        }
      }
      tickAutoScroll();
    });
  };

  const cleanup = (): void => {
    ghost?.remove();
    ghost = null;
    setTarget(null);
    doc.documentElement.classList.remove('gr-dragging');
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    doc.removeEventListener('pointermove', onMove, true);
    doc.removeEventListener('pointerup', onUp, true);
    doc.removeEventListener('pointercancel', onCancel, true);
    doc.removeEventListener('keydown', onKey, true);
    captureEl = null;
  };

  /** A `click` follows the release of a slide: it is absorbed (it must not select or open a menu). */
  const swallowClick = (): void => {
    const h = (ev: Event): void => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    doc.addEventListener('click', h, { capture: true, once: true });
    setTimeout(() => doc.removeEventListener('click', h, true), 0);
  };

  function onMove(e: PointerEvent): void {
    pointer = { x: e.clientX, y: e.clientY };
    refresh(e.clientX, e.clientY, e.pointerId);
  }

  function onUp(e: PointerEvent): void {
    const wasDragging = state.phase === 'dragging';
    const hit = wasDragging ? targetAt(e.clientX, e.clientY) : null;
    const next = release(state, e.pointerId, e.clientX, e.clientY, hit?.ref ?? null);
    try {
      captureEl?.releasePointerCapture?.(e.pointerId);
    } catch {
      /* already released */
    }
    cleanup();
    state = IDLE;
    if (wasDragging) swallowClick();
    if (next.phase === 'dropped') {
      if (!ui.centerIsGraph) ui.closeCenter();
      const head = refs.head ?? repo.head ?? { branch: null, detached: false };
      dnd.open(next.src, next.dst, next.x, next.y, { branch: head.branch, detached: head.detached });
    }
  }

  function onCancel(): void {
    cleanup();
    state = cancel(state);
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || (state.phase !== 'pressed' && state.phase !== 'dragging')) return;
    e.preventDefault();
    e.stopPropagation();
    onCancel();
  }

  const onDown = (e: PointerEvent): void => {
    if (e.button !== 0 || e.isPrimary === false || dnd.menu) return;
    const src = refOf(e.target as Element | null);
    if (!src) return;
    if (!canStartDrag({ busy: op.busy, opInProgress: op.state !== null })) return;
    pointer = { x: e.clientX, y: e.clientY };
    state = press(IDLE, src, e.pointerId, e.clientX, e.clientY, true);
    doc.addEventListener('pointermove', onMove, true);
    doc.addEventListener('pointerup', onUp, true);
    doc.addEventListener('pointercancel', onCancel, true);
    doc.addEventListener('keydown', onKey, true);
  };

  doc.addEventListener('pointerdown', onDown, true);
  return () => {
    doc.removeEventListener('pointerdown', onDown, true);
    cleanup();
    state = IDLE;
  };
}
