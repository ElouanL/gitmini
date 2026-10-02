import { scopedStore, type Session } from './session.svelte';
// Store `ui`: shared presentation status (central area, drawer, tip strips, palette, context menu).
// Nothing is persisted here (03 "UI Persistence": only `theme`, `pull.mode`, `editor.command`, `layout` are)
import type { MenuTarget } from '../menus/types';

export type HintId = 'commit-graph' | 'watcher-degraded';

export interface CenterView {
  /** `graph` (default) or a view saved by `registerCenterView` (`diff`...). */
  id: string;
  props: Record<string, unknown>;
}

export interface OpenMenu {
  target: MenuTarget;
  x: number;
  y: number;
  /** Item to be re-focused when closing (keyboard opening). */
  returnFocus: HTMLElement | null;
}

export interface OpenPopover {
  id: string;
  anchor: HTMLElement;
  props: Record<string, unknown>;
}

const GRAPH: CenterView = { id: 'graph', props: {} };

export class UiStore {
  constructor(readonly owner: Session) {}
  sidebarOpen = $state({ local: true, remote: true, tags: true, stashes: true });
  sidebarRemotesOpen = $state<Record<string, boolean>>({});
  centerView = $state.raw<CenterView>(GRAPH);
  /** Drawer right of the graph (`reflog-panel`...), `null` = closed. */
  drawer = $state<string | null>(null);
  paletteOpen = $state(false);
  /** Popover anchored to a toolbar button (`github-menu`...), recorded by `registerPopover`. */
  popover = $state.raw<OpenPopover | null>(null);
  contextMenu = $state.raw<OpenMenu | null>(null);
  /** Tips requested (e.g. `commit-graph` if > 50,000 commits without commit-graph) and hidden tricks for the session. */
  hints = $state.raw<readonly HintId[]>([]);
  dismissedHints = $state.raw<readonly HintId[]>([]);
  /** Close window (< 1200 px): the right panel becomes a pane superimposed on the graph. */
  narrow = $state(false);
  rightOverlayOpen = $state(false);
  /** Incremented meter to request the focus of an area (`Mod+1/2/3`) from a component that observes it. */
  focusRequest = $state.raw<{ zone: 'sidebar' | 'graph' | 'right'; nonce: number } | null>(null);
  #nonce = 0;

  openCenter(id: string, props: Record<string, unknown> = {}): void {
    this.centerView = { id, props };
  }

  /** Returns to the graph (scroll position and selection retained: the graph remains mounted under the diff). */
  closeCenter(): void {
    if (this.centerView.id !== 'graph') this.centerView = GRAPH;
  }

  get centerIsGraph(): boolean {
    return this.centerView.id === 'graph';
  }

  openDrawer(id: string): void {
    this.drawer = id;
  }
  closeDrawer(): void {
    this.drawer = null;
  }
  toggleDrawer(id: string): void {
    this.drawer = this.drawer === id ? null : id;
  }

  openPopover(id: string, anchor: HTMLElement, props: Record<string, unknown> = {}): void {
    this.popover = { id, anchor, props };
  }
  closePopover(): void {
    const p = this.popover;
    this.popover = null;
    p?.anchor.focus?.();
  }
  togglePopover(id: string, anchor: HTMLElement, props: Record<string, unknown> = {}): void {
    if (this.popover?.id === id) this.closePopover();
    else this.openPopover(id, anchor, props);
  }

  showHint(id: HintId): void {
    if (!this.hints.includes(id)) this.hints = [...this.hints, id];
  }
  hideHint(id: HintId): void {
    if (this.hints.includes(id)) this.hints = this.hints.filter((h) => h !== id);
  }
  dismissHint(id: HintId): void {
    if (!this.dismissedHints.includes(id)) this.dismissedHints = [...this.dismissedHints, id];
  }
  /** Tips to display: requested and not hidden. */
  get activeHints(): HintId[] {
    return this.hints.filter((h) => !this.dismissedHints.includes(h));
  }

  requestFocus(zone: 'sidebar' | 'graph' | 'right'): void {
    this.focusRequest = { zone, nonce: ++this.#nonce };
  }

  /** Closing the repository: everything that is unique to the repository is zero (the hidden tricks also: "until the repository is closed"). */
  resetForRepo(): void {
    this.sidebarOpen = { local: true, remote: true, tags: true, stashes: true };
    this.sidebarRemotesOpen = {};
    this.centerView = GRAPH;
    this.drawer = null;
    this.contextMenu = null;
    this.popover = null;
    this.paletteOpen = false;
    this.hints = [];
    this.dismissedHints = [];
    this.rightOverlayOpen = false;
  }
}

const binding = scopedStore('ui', (owner) => new UiStore(owner));
export const ui = binding.current;
export const uiFor = binding.for;
