// Store `graph`: pages of the loaded log (6 max), epoch, oid selection.
// Shared state (the selection controls the right panel); the logic of pagination / viewport / search / rendered lives in
// src/lib/components/graph/** (graph agent), which publishes its pages here and records `registerRefresher` / `registerRevealer`.
import { commands } from '../ipc/commands';
import type { LogPage } from '../ipc/types';
import { reportError } from '../errors/report';
import { isAppError } from '../ipc/transport';
import { perfMark } from '../perf';
import { evictFarthest, mergePage, sortPages } from '../components/graph/model/pages';
import { scopedStore, type Session } from './session.svelte';

export type Oid = string;

/** What is selected in the graph. Determines the right panel (03 "Right panel"). */
export type Selection =
  | { kind: 'none' }
  | { kind: 'wip' }
  /** One or more commits (`oids` in order of selection; `anchor` for Shift beaches). */
  | { kind: 'commits'; oids: Oid[]; anchor: Oid }
  | { kind: 'stash'; oid: Oid; index: number };

export const MAX_PAGES = 6;

/** Provides the true "reload the visible page" (graph agent); replaces the basic behavior. */
export type GraphRefresher = () => Promise<void>;
/** Selects a commit and makes it visible, loading its page if necessary (graph agent). */
export type GraphRevealer = (oid: Oid) => Promise<void>;

/** Slided branch / drag-and-drop target: `name` is the short name of the IPC commands (`feature`, `origin/feature`). */
export interface DropRef {
  fullRef: string;
  kind: "local" | 'remote';
  name: string;
}

/** Share contract `drag.rebase` / `drag.merge`: posed by the graph during the execution of the action (see src/README.md). */
export interface DropPayload {
  /** Branch slipped. */
  src: DropRef;
  /** Target branch. */
  dst: DropRef;
}

export type AddPageResult = 'added' | 'replaced' | 'stale' | 'newer';

export class GraphStore {
  constructor(readonly owner: Session) {}
  pages = $state.raw<LogPage[]>([]);
  epoch = $state(0);
  scrollTop = $state(0);
  selection = $state.raw<Selection>({ kind: 'none' });
  searchOpen = $state(false);
  searchQuery = $state('');
  loading = $state(false);
  /** Scroll request up to a commit (graph view looks at it). */
  revealRequest = $state.raw<{ oid: Oid; nonce: number } | null>(null);
  /** Rank (graph order) of selected commits, when known: orders comparison of two commits (`against`). */
  rowHints = $state.raw<Record<Oid, number>>({});
  /** Drag and drop while being processed by a repository menu / `drag.*` action. */
  dragDrop = $state.raw<DropPayload | null>(null);

  #total = $state<number | null>(null);
  #lanes = $state(0);
  #nonce = 0;
  #refresher: GraphRefresher | null = null;
  #revealer: GraphRevealer | null = null;
  #indexMarked = false;
  #onIndexComplete: (() => void) | null = null;

  /**
   * Called to the first announcement of a non-zero `total` (graph index is complete). `refs_list` and `status_get` return ahead/behind
   * to `null` until the index is ready and no event announces it: `stores/wiring.ts` plugs in their rereading.
   */
  onIndexComplete(fn: (() => void) | null): void {
    this.#onIndexComplete = fn;
  }

  // ── Pages

  /** Replaces the loaded pages (6 max, `epoch` of the first) and the metadata (total, lanes) is removed from these pages. */
  setPages(pages: LogPage[]): void {
    const kept = pages.length > MAX_PAGES ? pages.slice(-MAX_PAGES) : pages;
    this.pages = kept;
    this.epoch = kept[0]?.epoch ?? 0;
    this.#total = null;
    this.#lanes = 0;
    for (const p of pages) this.#noteMeta(p);
  }

  /**
   * Adds a page of the same epoch (the most recent one takes precedence over the covered rows) and releases the furthest `centerRow`.
   * Older Epoch: ignored (`stale`). Newer: not added (`newer`), the caller must reload the visible page.
   */
  addPage(page: LogPage, centerRow: number): AddPageResult {
    if (this.pages.length === 0) {
      this.setPages([page]);
      return 'replaced';
    }
    if (page.epoch < this.epoch) return 'stale';
    if (page.epoch > this.epoch) return 'newer';
    this.pages = evictFarthest(mergePage(this.pages, page), centerRow, MAX_PAGES);
    this.#noteMeta(page);
    return 'added';
  }

  /** Total and max width announced by a response (sound of `total` during index construction). */
  noteMeta(page: Pick<LogPage, 'total' | 'maxLanes' | 'epoch'>): void {
    if (page.epoch === this.epoch) this.#noteMeta(page);
  }

  #noteMeta(p: Pick<LogPage, 'total' | 'maxLanes'>): void {
    if (p.total !== null && p.total !== undefined) {
      this.#total = p.total;
      if (!this.#indexMarked) {
        this.#indexMarked = true;
        perfMark('gitmini:graph-index-complete');
        this.#onIndexComplete?.();
      }
    }
    if (p.maxLanes > this.#lanes) this.#lanes = p.maxLanes;
  }

  /** Total number of rows when index is complete, otherwise `null`. */
  get total(): number | null {
    return this.#total;
  }

  get maxLanes(): number {
    return this.#lanes;
  }

  /** First page (first screen, B2). */
  async loadFirstPage(): Promise<void> {
    const repoId = this.owner.repoId;
    if (repoId === null) return;
    const gen = this.owner.gen;
    this.loading = true;
    try {
      const page = await commands.logPage({ repoId, cursor: null });
      if (this.owner.isCurrent(gen)) this.setPages([page]);
    } catch (e) {
      if (!this.owner.isCurrent(gen)) return;
      reportError(e, { repoId: this.owner.repoId, command: 'log_page' });
    } finally {
      this.loading = false;
    }
  }

  registerRefresher(fn: GraphRefresher | null): void {
    this.#refresher = fn;
  }

  registerRevealer(fn: GraphRevealer | null): void {
    this.#revealer = fn;
  }

  /**
   * Reload the visible page after `repo:changed { refs | head | stash }`, selected by oid (03 "Refreshment").
   * Basic behavior: re-reads around the anchor of the selection, if not the first page.
   */
  async refreshVisible(): Promise<void> {
    if (this.#refresher) return this.#refresher();
    const repoId = this.owner.repoId;
    if (repoId === null) return;
    const gen = this.owner.gen;
    const sel = this.selection;
    const aroundOid = sel.kind === 'commits' ? sel.anchor : sel.kind === 'stash' ? sel.oid : undefined;
    try {
      const page = await commands.logPage({ repoId, cursor: null, ...(aroundOid ? { aroundOid } : {}) });
      if (this.owner.isCurrent(gen)) this.setPages([page]);
    } catch (e) {
      if (!this.owner.isCurrent(gen)) return;
      if (isAppError(e) && e.code === 'NOT_FOUND' && aroundOid) {
        // The selection became inaccessible: first page, empty selection (04 "In error cases").
        this.clearSelection();
        await this.loadFirstPage();
        return;
      }
      if (isAppError(e) && e.code === 'STALE') return this.refreshVisible();
      reportError(e, { repoId: this.owner.repoId, command: 'log_page', quiet: true });
    }
  }

  // - - - Selections . . . . . .

  get selectedOids(): Oid[] {
    const s = this.selection;
    return s.kind === 'commits' ? s.oids : s.kind === 'stash' ? [s.oid] : [];
  }

  /** Unique Oid if exactly a commit is selected. */
  get singleCommitOid(): Oid | null {
    const s = this.selection;
    return s.kind === 'commits' && s.oids.length === 1 ? (s.oids[0] ?? null) : null;
  }

  isSelected(oid: Oid): boolean {
    return this.selectedOids.includes(oid);
  }

  /** Replaces the selection (used by the graph view, which calculates click / range / keyboard with `model/selection.ts`). */
  setSelection(sel: Selection): void {
    this.selection = sel;
  }

  selectCommit(oid: Oid): void {
    this.selection = { kind: 'commits', oids: [oid], anchor: oid };
  }

  selectCommits(oids: Oid[], anchor?: Oid): void {
    if (oids.length === 0) this.selection = { kind: 'none' };
    else this.selection = { kind: 'commits', oids, anchor: anchor ?? oids[0]! };
  }

  /** `Mod`+click: add or remove a commit from the selection (one commit at a time only among commits). */
  toggleCommit(oid: Oid): void {
    const s = this.selection;
    if (s.kind !== 'commits') return this.selectCommit(oid);
    const oids = s.oids.includes(oid) ? s.oids.filter((o) => o !== oid) : [...s.oids, oid];
    this.selectCommits(oids, oids.includes(oid) ? oid : (oids[0] ?? undefined));
  }

  selectWip(): void {
    this.selection = { kind: 'wip' };
  }

  selectStash(oid: Oid, index: number): void {
    this.selection = { kind: 'stash', oid, index };
  }

  clearSelection(): void {
    this.selection = { kind: 'none' };
  }

  /** Memorizes the rank of a commit (graph order). */
  noteRow(oid: Oid, row: number): void {
    if (this.rowHints[oid] !== row) this.rowHints = { ...this.rowHints, [oid]: row };
  }

  /** `true` if the line of the commit is one of the pages loaded. */
  hasLoaded(oid: Oid): boolean {
    return this.pages.some((p) => p.rows.some((r) => r.oid === oid));
  }

  /**
   * Selects a commit and asks the graph view to make it visible (sidebar: just click on a branch).
   * Without IPC if the line is loaded, otherwise `log_page { aroundOid }` (03 "Sidebar").
   */
  async reveal(oid: Oid): Promise<void> {
    if (this.#revealer) return this.#revealer(oid);
    this.selectCommit(oid);
    if (!this.hasLoaded(oid)) {
      const repoId = this.owner.repoId;
      if (repoId === null) return;
      const gen = this.owner.gen;
      try {
        const page = await commands.logPage({ repoId, cursor: null, aroundOid: oid });
        if (!this.owner.isCurrent(gen)) return;
        this.setPages([page]);
      } catch (e) {
        if (!this.owner.isCurrent(gen)) return;
        reportError(e, { repoId: this.owner.repoId, command: 'log_page' });
        return;
      }
    }
    this.revealRequest = { oid, nonce: ++this.#nonce };
  }

  /** Ask the view to scroll to `oid` (already loaded). */
  requestReveal(oid: Oid): void {
    this.revealRequest = { oid, nonce: ++this.#nonce };
  }

  /** Pages sorted by rank (diagnosis). */
  get sortedPages(): LogPage[] {
    return sortPages(this.pages);
  }

  reset(): void {
    this.pages = [];
    this.epoch = 0;
    this.scrollTop = 0;
    this.selection = { kind: 'none' };
    this.searchOpen = false;
    this.searchQuery = '';
    this.loading = false;
    this.revealRequest = null;
    this.rowHints = {};
    this.dragDrop = null;
    this.#total = null;
    this.#lanes = 0;
    this.#indexMarked = false;
  }
}

const binding = scopedStore('graph', (owner) => new GraphStore(owner));
export const graph = binding.current;
export const graphFor = binding.for;
