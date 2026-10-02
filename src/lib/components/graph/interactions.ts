// Graphical view interactions: click, `Mod`+click, `Shift`+click, keyboard, right click, double-clic on a label.
// The selection logic is PURE (model/selection.ts), this file translates DOM events and applies the result to the store.
import { checkoutTarget } from '$lib/actions/checkout';
import { focusZone } from '$lib/actions/focus';
import { isMac } from '$lib/actions/shortcuts';
import { reportError } from '$lib/errors/report';
import { openContextMenu } from '$lib/menus/registry';
import type { MenuTarget } from '$lib/menus/types';
import type { BranchInfo, RemoteBranchInfo, StashEntry, TagInfo } from '$lib/ipc/types';
import { graph } from '$lib/stores/graph.svelte';
import { op } from '$lib/stores/op.svelte';
import { refs } from '$lib/stores/refs.svelte';
import type { GraphController } from './controller.svelte';
import { NAV_KEYS, navTarget, navigate, pick, type NavKey, type Picked } from './model/selection';

const LABEL_SELECTOR = '[data-testid="graph-ref-label"]';

interface Hit {
  index: number;
  kind: string;
}

/** Pool line under the event target. */
export function rowFromEvent(e: Event): Hit | null {
  const el = (e.target as Element | null)?.closest?.('.gr-row') ?? null;
  if (!el || (el as HTMLElement).hidden) return null;
  const index = Number(el.getAttribute('data-index'));
  return Number.isFinite(index) ? { index, kind: el.getAttribute('data-kind') ?? '' } : null;
}

function apply(ctrl: GraphController, p: Picked): void {
  graph.setSelection(p.selection);
  ctrl.anchorRow = p.anchorRow;
  ctrl.cursorRow = p.cursorRow;
  if (p.selection.kind === 'commits') {
    for (const oid of p.selection.oids) {
      const r = ctrl.rowOf(oid);
      if (r >= 0) graph.noteRow(oid, r);
    }
  }
}

export function handleClick(ctrl: GraphController, e: MouseEvent): void {
  if (e.button !== 0) return;
  const hit = rowFromEvent(e);
  if (!hit) return;
  const info = ctrl.rowInfo(hit.index);
  ctrl.els?.viewport.focus({ preventScroll: true });
  if (!info) return; // skeleton line (page not yet loaded)
  const mac = isMac();
  apply(ctrl, pick(graph.selection, info, { mod: mac ? e.metaKey : e.ctrlKey, shift: e.shiftKey }, ctrl.anchorRow, (i) => ctrl.rowInfo(i)));
}

export function handlePointerMove(ctrl: GraphController, e: PointerEvent): void {
  const hit = rowFromEvent(e);
  ctrl.setHover(hit ? hit.index : null);
}

// ── Clic droit

function branchOf(fullRef: string, oid: string): BranchInfo {
  return (
    refs.snapshot?.local.find((b) => b.fullRef === fullRef) ?? {
      name: fullRef.slice('refs/heads/'.length), fullRef, oid, isHead: false, upstream: null, tipDate: 0,
    }
  );
}

function remoteBranchOf(fullRef: string, oid: string): RemoteBranchInfo {
  const found = refs.snapshot?.remote.find((b) => b.fullRef === fullRef);
  if (found) return found;
  const rest = fullRef.slice('refs/remotes/'.length);
  const i = rest.indexOf('/');
  return { remote: i < 0 ? rest : rest.slice(0, i), name: i < 0 ? '' : rest.slice(i + 1), fullRef, oid };
}

function tagOf(fullRef: string, oid: string): TagInfo {
  return refs.snapshot?.tags.find((x) => x.fullRef === fullRef) ?? { name: fullRef.slice('refs/tags/'.length), fullRef, oid, targetOid: oid, annotated: false };
}

function stashOf(ctrl: GraphController, index: number): StashEntry | null {
  const r = ctrl.rowData(index);
  if (!r || r.kind !== 'stash') return null;
  return (
    refs.stashes.find((s) => s.index === r.stashIndex && s.oid === r.oid) ??
    refs.stashes.find((s) => s.oid === r.oid) ?? {
      index: r.stashIndex ?? 0, oid: r.oid, message: r.summary, branch: null, baseOid: r.parents[0] ?? '', hasIndex: false, hasUntracked: false, time: r.time,
    }
  );
}

/** Target of a row's contextual menu; applies the rule "an out-of-selection line replaces it". */
export function menuTargetForRow(ctrl: GraphController, index: number): MenuTarget | null {
  const info = ctrl.rowInfo(index);
  if (!info) return null;
  if (info.kind === 'wip') {
    if (graph.selection.kind !== 'wip') apply(ctrl, { selection: { kind: 'wip' }, anchorRow: -1, cursorRow: -1 });
    return { menu: 'wip' };
  }
  if (info.kind === 'stash') {
    const stash = stashOf(ctrl, index);
    if (!stash) return null;
    if (!(graph.selection.kind === 'stash' && graph.selection.oid === info.oid)) {
      apply(ctrl, { selection: { kind: 'stash', oid: info.oid, index: info.stashIndex ?? 0 }, anchorRow: index, cursorRow: index });
    }
    return { menu: 'stash', stash };
  }
  if (!graph.isSelected(info.oid) || graph.selection.kind !== 'commits') {
    apply(ctrl, { selection: { kind: 'commits', oids: [info.oid], anchor: info.oid }, anchorRow: index, cursorRow: index });
  }
  return { menu: 'commit', oid: info.oid, oids: graph.selectedOids };
}

export function menuTargetForLabel(ctrl: GraphController, label: Element): MenuTarget | null {
  const ref = label.getAttribute('data-ref') ?? '';
  const kind = label.getAttribute('data-ref-kind');
  const row = label.closest('.gr-row')?.getAttribute('data-oid') ?? '';
  void ctrl;
  if (kind === "local") return { menu: 'branch', branch: branchOf(ref, row) };
  if (kind === 'remote') return { menu: 'remote-branch', branch: remoteBranchOf(ref, row) };
  if (kind === 'tag') return { menu: 'tag', tag: tagOf(ref, row) };
  return null;
}

export function handleContextMenu(ctrl: GraphController, e: MouseEvent): void {
  const label = (e.target as Element | null)?.closest?.(LABEL_SELECTOR) ?? null;
  let target: MenuTarget | null = null;
  if (label) target = menuTargetForLabel(ctrl, label);
  if (!target) {
    const hit = rowFromEvent(e);
    if (hit) target = menuTargetForRow(ctrl, hit.index);
  }
  if (!target) return;
  e.preventDefault();
  openContextMenu(target, e.clientX, e.clientY, null);
}

// "Double-click on a label: checkout
export function handleDblClick(e: MouseEvent): void {
  const label = (e.target as Element | null)?.closest?.(LABEL_SELECTOR) ?? null;
  if (!label || op.busy) return;
  const ref = label.getAttribute('data-ref') ?? '';
  const kind = label.getAttribute('data-ref-kind');
  if (kind === "local") {
    const name = ref.slice('refs/heads/'.length);
    if (refs.snapshot?.local.find((b) => b.name === name)?.isHead) return;
    void checkoutTarget({ kind: "local", name });
  } else if (kind === 'remote') {
    void checkoutTarget({ kind: 'remote', ref: ref.slice('refs/remotes/'.length) });
  }
}

// ── Clavier

let navChain: Promise<void> = Promise.resolve();

async function navigateKey(ctrl: GraphController, key: NavKey, shift: boolean): Promise<void> {
  let total = graph.total;
  if (key === 'End' && total === null) total = await ctrl.resolveTotal();
  const rowCount = total ?? ctrl.rowCount;
  const target = navTarget(key, ctrl.cursorRow, {
    rowCount, wip: ctrl.wipVisible, fallback: ctrl.visibleRange().first, step: ctrl.pageStep(),
  });
  if (target >= 0 && !ctrl.rowData(target)) {
    if (!(await ctrl.jumpToRow(target, 'nearest'))) return;
  }
  const info = ctrl.rowInfo(target);
  if (!info) return;
  apply(ctrl, navigate(graph.selection, info, shift, ctrl.anchorRow, (i) => ctrl.rowInfo(i)));
  // PageUp / PageDown turn the page (viewport scrolls from the same number of rows as the cursor), other keys do
  // the minimum scrolling that keeps the selected line visible.
  if (key === 'PageUp') ctrl.scrollByRows(-ctrl.pageStep());
  else if (key === 'PageDown') ctrl.scrollByRows(ctrl.pageStep());
  ctrl.scrollToRow(target, 'nearest');
}

export function handleKeyDown(ctrl: GraphController, e: KeyboardEvent): void {
  if (e.defaultPrevented || e.isComposing) return;
  const mod = e.metaKey || e.ctrlKey || e.altKey;

  if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') {
    const row = ctrl.cursorRow ?? ctrl.visibleRange().first;
    const target = menuTargetForRow(ctrl, row);
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    const vp = ctrl.els?.viewport;
    const r = vp?.getBoundingClientRect();
    openContextMenu(target, (r?.left ?? 0) + Math.min(280, (r?.width ?? 0) / 2), (r?.top ?? 0) + Math.max(0, Math.min(ctrl.rowTop(row) + 28, (r?.height ?? 0) - 8)), vp ?? null);
    return;
  }
  if (mod) return;
  if (NAV_KEYS.has(e.key)) {
    e.preventDefault();
    const key = e.key as NavKey;
    const shift = e.shiftKey;
    // An unexpected exception is reported (never swallowed) and does not break the line of the following keys.
    navChain = navChain.then(() => navigateKey(ctrl, key, shift)).catch((e: unknown) => void reportError(e));
    return;
  }
  if (e.key === 'Enter' && graph.selection.kind !== 'none') {
    e.preventDefault();
    focusZone('right');
  }
}
