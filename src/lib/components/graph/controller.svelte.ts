import { captureStores } from '$lib/stores/context';
/* eslint-disable svelte/prefer-svelte-reactivity -- Set / Map used inside the render loop: intentionally nonreactive (read each frame, never by a template). */
// Graphics view controller: virtualized viewport, rendering loop (Canvas + pool DOM), pagination, oid scroll anchors,
// search. Only one `requestAnimationFrame` per frame, no layout reading in the loop (size comes from the
// ResizeObserver, `scrollTop` event `scroll`). Markup and events are in GraphView.svelte / interactions.ts.
import { commands } from '$lib/ipc/commands';
import { isAppError } from '$lib/ipc/transport';
import { beginActivity } from '$lib/activity';
import { perfMark } from '$lib/perf';
import { app } from '$lib/stores/app.svelte';
import { createCoalescer, type Coalescer } from '$lib/stores/schedule';
import type { GraphRow, LogMatch, LogPage } from '$lib/ipc/types';
import { t } from '$i18n/index';
import { captureAnchor, restoreAnchor, type Anchor } from './model/anchor';
import { formatGraphDate, avatarColor, initials } from './model/format';
import {
  PAGE_LIMIT, ROW_H, columnLayout, estimateRowCount, hiddenLanes, pageStep, poolSize, rowWindow, scrollMapping, scrollToVrow,
  vrowAtY, type ColumnLayout, type RowWindow,
} from './model/geometry';
import { layoutLabels } from './model/labels';
import { PageLoader, TotalProbe } from './model/loader';
import { PageView, historyEnd, loadedEnd, findPage, type LoadRequest } from './model/pages';
import { Reachability } from './model/reach';
import type { RowInfo } from './model/selection';
import { SearchEngine } from './model/search.svelte';
import { draw, type DrawParams } from './render/renderer';
import { FALLBACK_PALETTE, readPalette, type Palette } from './render/palette';
import { RowPool, bindRow, clearRow, place, setSelected, type RowDesc } from './render/pool';

export interface ControllerEls {
  /** View root: carries column width variables (header and lines share them). */
  root: HTMLElement;
  viewport: HTMLElement;
  sizer: HTMLElement;
  stage: HTMLElement;
  canvas: HTMLCanvasElement;
  rows: HTMLElement;
}

const DRAW_SAMPLES = 600;
/** Number of lines to draw before laying `gitmini:graph-first-paint` (04 / 02 B2: "First 60 lines"). */
const FIRST_PAINT_ROWS = 60;

let active: GraphController | null = null;
/** Mounted view controller (test deck, external actions). */
export function activeGraph(): GraphController | null {
  return active;
}
function setActive(c: GraphController | null): void {
  active = c;
}

export class GraphController {
  readonly #scope = captureStores();
  // "Reactive state (gabarit)
  columns = $state.raw<ColumnLayout>(columnLayout(1000, 1));
  /** repository without commit (`graph-empty-state`). */
  empty = $state(false);
  /** Unloaded visible lines + flight page (`graph-loading`). */
  missingVisible = $state(false);
  pagesLoading = $state(false);
  /** Lanes beyond 12: number of masked columns (degraded + infobulle). */
  hiddenLaneCount = $state(0);

  readonly search: SearchEngine;

  // ── DOM
  #els: ControllerEls | null = null;
  #ctx: CanvasRenderingContext2D | null = null;
  #pool: RowPool | null = null;
  #ro: ResizeObserver | null = null;
  #gen = 0;
  #mounted = false;

  // Viewport geometry.
  #w = 0;
  #h = 0;
  #dpr = 1;
  #scrollTop = 0;
  #restoreScroll = true;
  #vTop = 0;
  #scale = 1;
  #physH = -1;
  #rowsTransform = '';
  #win: RowWindow = { firstVisible: 0, lastVisible: 0, first: 0, last: 0 };
  #raf = 0;
  #rev = 0;
  #off = 0;
  #rowCount = 0;

  // Cached graph data.
  /** Cache view pages (`#pv`), and pages seen by the last frame (detects a change to be reported on the DOM). */
  #pages: readonly LogPage[] = [];
  #framePages: readonly LogPage[] | null = null;
  #view = new PageView([]);
  #reach = new Reachability();
  #palette: Palette = FALLBACK_PALETTE;
  #sel = new Set<string>();
  #stashSel: string | null = null;
  #wipSel = false;
  #matchRows: Set<number> | null = null;
  #hover: number | null = null;
  /** Reagent: `graph-empty-state` is placed under the line WIP when it appears or disappears after mounting. */
  #wip = $state(false);
  #wipCounts = { unstaged: 0, staged: 0, conflicts: 0 };
  #dim = true;
  #headOid: string | null = null;
  /** HEAD as published by stores (read by `onRepo`, never in the rendering loop). */
  #headTarget: string | null = null;
  #headRow = -3;
  #headLane = 0;
  #headColor = 0;
  #upstreams = new Map<string, string>();
  #shallow = false;
  #now = Date.now();
  #firstPaint = false;
  /** Frame durations (`DRAW_SAMPLES` ring measures): `draw` + pool writing (B5). */
  #dt = new Float64Array(DRAW_SAMPLES);
  #dtCount = 0;
  #lastLanes = -1;
  /** The `total` probe failed (already reported error): it does not loop. */
  #probeFailed = false;
  #clock: ReturnType<typeof setInterval> | null = null;
  #lastEnsureKey = '';
  #activeId = '';
  /** Requests `log_page` issued by the graph, by origin (test deck: "only the necessary pages are requested", GRAPH-04). */
  readonly #requests = { cursor: 0, startRow: 0, around: 0, refresh: 0, probe: 0 };

  // Keyboard cursor and selection anchor.
  cursorRow: number | null = null;
  anchorRow: number | null = null;

  readonly #loader: PageLoader;
  readonly #probe: TotalProbe;
  readonly #refreshing: Coalescer;
  #params: DrawParams;

  constructor() {
    this.#params = {
      w: 0, h: 0, dpr: 1, vTop: 0, first: 0, last: 0, wip: false, graphX: 0, graphW: 0, maxLanes: 0,
      rows: this.#view, rowCount: 0, selected: this.#sel, stashSelected: null, wipSelected: false, hoverRow: null, matchRows: null,
      headOid: null, wipLane: 0, wipColor: 0, headRow: -3, palette: this.#palette,
    };
    this.search = new SearchEngine({
      search: (query, limit) => {
        const repoId = this.#scope.session.repoId;
        if (repoId === null) return Promise.reject(new Error("No repository open"));
        return commands.logSearch({ repoId, query, limit });
      },
      go: (m) => void this.goToMatch(m),
      currentOid: () => this.#scope.graph.singleCommitOid,
      onError: (e) => this.#scope.reportError(e, { command: 'log_search' }),
    });
    this.#loader = new PageLoader({
      fetch: (req) => this.#fetchPage(req),
      getPages: () => this.#scope.graph.pages,
      getTotal: () => this.#scope.graph.total,
      getView: () => (this.#mounted && this.#h > 0 ? { firstRow: Math.max(0, this.#win.first - this.#off), lastRow: this.#win.last - this.#off, center: this.#centerRow() } : null),
      apply: (page, center) => this.#scope.graph.addPage(page, center),
      noteMeta: (page) => this.#scope.graph.noteMeta(page),
      onStale: () => void this.refresh(),
      onError: (e) => this.#scope.reportError(e, { command: 'log_page' }),
      isCurrent: () => this.#mounted && this.#scope.session.isCurrent(this.#gen),
      onLoading: (l) => {
        this.pagesLoading = l;
        this.#updateMissing();
      },
      isStaleCursor: (e) => isAppError(e) && e.code === 'STALE' && e.details?.what === 'cursor',
    });
    this.#probe = new TotalProbe(
      async () => {
        const repoId = this.#scope.session.repoId;
        if (repoId === null || !this.#mounted) return;
        const gen = this.#gen;
        try {
          this.#requests.probe++;
          const page = await commands.logPage({ repoId, cursor: null, startRow: 0, limit: 1 });
          if (!this.#scope.session.isCurrent(gen)) return;
          if (page.epoch > this.#scope.graph.epoch) void this.refresh();
          else this.#scope.graph.noteMeta(page);
        } catch (e) {
          // Never swallowed: routed by handleError. A failed probe stops (one toast per turn would be harassment);
          // the next rereading (new epoch) the restart, and `End` gets `total` by `resolveTotal`.
          this.#probeFailed = true;
          this.#scope.reportError(e, { command: 'log_page' });
        }
      },
      () => !this.#mounted || this.#scope.graph.total !== null || this.#probeFailed,
    );
    this.#refreshing = createCoalescer(() => this.#doRefresh());
  }

  // ── Cycle de vie

  mount(els: ControllerEls): void {
    this.#els = els;
    this.#mounted = true;
    this.#gen = this.#scope.session.gen;
    this.#scrollTop = this.#scope.graph.scrollTop;
    // The saved offset already includes WIP. Establish its baseline before status effects
    // run, so returning to a tab does not compensate by another row on every mount.
    this.#wip = this.#scope.status.files.length > 0;
    this.#off = this.#wip ? 1 : 0;
    this.search.query = this.#scope.graph.searchQuery;
    if (this.#scope.graph.searchOpen && this.search.query) this.search.restart();
    setActive(this);
    try {
      // jsdom does not implement the Canvas (`getContext` journal "Not implemented") : we do not draw there.
      this.#ctx = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent) ? null : els.canvas.getContext('2d');
    } catch {
      this.#ctx = null;
    }
    this.#pool = new RowPool(els.rows);
    this.#palette = readPalette();
    this.#dim = app.get('graph.dimUnreachable');
    this.#headTarget = this.#scope.repo.head?.oid ?? null;
    this.#dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    if (typeof ResizeObserver !== 'undefined') {
      this.#ro = new ResizeObserver((entries) => {
        const r = entries[entries.length - 1]?.contentRect;
        if (r) this.resize(r.width, r.height);
      });
      this.#ro.observe(els.viewport);
    }
    this.#scope.graph.registerRefresher(() => this.refresh());
    this.#scope.graph.registerRevealer((oid) => this.reveal(oid));
    this.#startProbe();
    // The relative dates ("3 hours ago") are rewritten every minute.
    this.#clock = setInterval(() => {
      this.#now = Date.now();
      this.touch();
    }, 60_000);
    this.invalidate();
  }

  unmount(): void {
    this.#mounted = false;
    if (this.#raf) cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    this.#ro?.disconnect();
    this.#ro = null;
    this.#probe.stop();
    if (this.#clock !== null) clearInterval(this.#clock);
    this.#clock = null;
    this.search.close();
    this.#scope.graph.registerRefresher(null);
    this.#scope.graph.registerRevealer(null);
    if (active === this) setActive(null);
    this.#els = null;
    this.#pool = null;
    this.#ctx = null;
  }

  // - - - Inputs (viewport events, reactive effects)
  /** Viewport size (px CSS). Redessine immediately: the resized canvas would otherwise be empty until the next frame. */
  resize(w: number, h: number): void {
    const els = this.#els;
    if (!els || (w === this.#w && h === this.#h)) return;
    this.#w = w;
    this.#h = h;
    this.#dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    els.canvas.width = Math.max(1, Math.round(w * this.#dpr));
    els.canvas.height = Math.max(1, Math.round(h * this.#dpr));
    els.canvas.style.width = `${w}px`;
    els.canvas.style.height = `${h}px`;
    els.stage.style.height = `${h}px`;
    this.#pool?.grow(poolSize(h));
    this.#applyColumns();
    this.#rev++;
    // Immediate drawing (other than resized canvas remains empty a frame) without touch at container height: change
    // celle-ci makes the scroll bar appear / disappear, so vary the width observed, in the same pass of
    // ResizeObserver ("loop completed with undelivered notifications"). The height is updated to the next frame.
    this.#drawNow(false);
    this.invalidate();
  }

  onScroll(): void {
    const els = this.#els;
    if (!els) return;
    this.#scrollTop = els.viewport.scrollTop;
    this.#scope.graph.scrollTop = this.#scrollTop;
    this.invalidate();
  }

  /** A displayed data has changed (pages, status, refs, setting, selection...): next frame. */
  invalidate(): void {
    if (!this.#raf && this.#mounted && typeof requestAnimationFrame !== 'undefined') this.#raf = requestAnimationFrame(() => this.#frame());
  }

  /** The lines DOM and Canvas are rewritten (page received, labels, WIP, HEAD...). */
  touch(): void {
    this.#rev++;
    this.invalidate();
  }

  onTheme(): void {
    this.#palette = readPalette();
    this.invalidate();
  }

  onSettings(): void {
    const dim = app.get('graph.dimUnreachable');
    if (dim !== this.#dim) {
      this.#dim = dim;
      this.touch();
    }
  }

  onSelection(): void {
    const s = this.#scope.graph.selection;
    this.#sel = s.kind === 'commits' ? new Set(s.oids) : new Set();
    this.#stashSel = s.kind === 'stash' ? s.oid : null;
    this.#wipSel = s.kind === 'wip';
    // The keyboard cursor follows a selection placed elsewhere (sidebar, search).
    if (s.kind === 'commits' && s.oids.length === 1) {
      const r = this.#pv().rowOf(s.oids[0]!);
      if (r >= 0 && this.cursorRow !== r) {
        this.cursorRow = r;
        this.anchorRow = r;
      }
    } else if (s.kind === 'none') {
      this.cursorRow = null;
      this.anchorRow = null;
    }
    this.invalidate();
  }

  onRefs(): void {
    const m = new Map<string, string>();
    for (const b of this.#scope.refs.snapshot?.local ?? []) if (b.upstream) m.set(b.name, b.upstream.ref);
    this.#upstreams = m;
    this.touch();
  }

  /** Deposition and HEAD: surface root (shallow), Oid of HEAD (sampling, WIP node, accent ring). */
  onRepo(): void {
    this.#shallow = this.#scope.repo.info?.isShallow ?? false;
    this.#headTarget = this.#scope.repo.head?.oid ?? null;
    this.touch();
  }

  /** `this.#scope.status.snapshot`: presence and counters of line WIP; scrolling is compensated for not shifting lines. */
  onStatus(): void {
    const files = this.#scope.status.snapshot?.files ?? [];
    const wip = files.length > 0;
    let unstaged = 0;
    let staged = 0;
    let conflicts = 0;
    for (const f of files) {
      if (f.unstaged !== null) unstaged++;
      if (f.staged !== null) staged++;
      if (f.conflict !== null) conflicts++;
    }
    this.#wipCounts = { unstaged, staged, conflicts };
    if (wip !== this.#wip) {
      this.#wip = wip;
      this.#off = wip ? 1 : 0;
      if (!wip && this.#scope.graph.selection.kind === 'wip') this.#scope.graph.clearSelection();
      // The lines keep their place on the screen, except at the top where WIP appears / disappears above from HEAD.
      const els = this.#els;
      if (els && this.#scrollTop > 0) this.#setScrollTop(Math.max(0, this.#scrollTop + (wip ? ROW_H : -ROW_H)));
    }
    this.touch();
  }

  /** Search results → highlighted bands. */
  onMatches(): void {
    const m = this.search.matches;
    this.#matchRows = m.length ? new Set(m.map((x) => x.row)) : null;
    this.invalidate();
  }

  setHover(row: number | null): void {
    if (row === this.#hover) return;
    this.#hover = row;
    this.invalidate();
  }

  // - - Reading (test deck, interactions)
  get viewHeight(): number {
    return this.#h;
  }
  get viewWidth(): number {
    return this.#w;
  }
  get wipVisible(): boolean {
    return this.#wip;
  }
  get vTop(): number {
    return this.#vTop;
  }
  get poolSize(): number {
    return this.#pool?.size ?? 0;
  }
  get dpr(): number {
    return this.#dpr;
  }
  get els(): ControllerEls | null {
    return this.#els;
  }
  get headRow(): number {
    return this.#headRow;
  }
  get palette(): Palette {
    return this.#palette;
  }
  get requests(): { cursor: number; startRow: number; around: number; refresh: number; probe: number; total: number } {
    const r = this.#requests;
    return { ...r, total: r.cursor + r.startRow + r.around + r.refresh + r.probe };
  }
  /** Last frame durations (ms), from the oldest to the most recent. */
  drawTimes(): number[] {
    const n = Math.min(this.#dtCount, DRAW_SAMPLES);
    const out: number[] = [];
    for (let i = this.#dtCount - n; i < this.#dtCount; i++) out.push(this.#dt[i % DRAW_SAMPLES]!);
    return out;
  }
  resetDrawTimes(): void {
    this.#dtCount = 0;
  }

  /** Number of log lines used for scrolling (known or estimated: known lines + 10%). */
  get rowCount(): number {
    const pages = this.#scope.graph.pages;
    return estimateRowCount(loadedEnd(pages), this.#scope.graph.total, historyEnd(pages) !== Number.POSITIVE_INFINITY);
  }

  #pv(): PageView {
    if (this.#pages !== this.#scope.graph.pages) {
      this.#pages = this.#scope.graph.pages;
      this.#view = new PageView(this.#pages);
    }
    return this.#view;
  }

  /** Line at the actual row `index` (−1 = WIP), or `null` if it does not exist / is not loaded. */
  rowInfo(index: number): RowInfo | null {
    if (index === -1) return this.#wip ? { index: -1, kind: 'wip', oid: '', stashIndex: null } : null;
    const r = this.#pv().row(index);
    return r ? { index, kind: r.kind, oid: r.oid, stashIndex: r.stashIndex } : null;
  }

  rowData(index: number): GraphRow | null {
    return this.#pv().row(index);
  }

  rowOf(oid: string): number {
    return this.#pv().rowOf(oid);
  }

  /** Visible real rangs (without rendering margin): `first` can be −1 (line WIP). */
  visibleRange(): { first: number; last: number } {
    const w = this.#win;
    return { first: w.firstVisible - this.#off, last: Math.min(w.lastVisible, this.#rowCount + this.#off - 1) - this.#off };
  }

  /** Real Rang under the `y` command (px from the top of the viewport) — pure collision test, without page layout reading. */
  rowAtY(y: number): number {
    return vrowAtY(y, this.#vTop) - this.#off;
  }

  /** Top (px, in the viewport) of the real row line `row`. */
  rowTop(row: number): number {
    return (row + this.#off) * ROW_H - this.#vTop;
  }

  pageStep(): number {
    return pageStep(this.#h);
  }

  // - - - Scrolling
  /** Sets `scrollTop` (the container height is first updated: otherwise the browser limits the value). */
  #setScrollTop(top: number): void {
    const els = this.#els;
    if (!els) return;
    this.#applySizer();
    els.viewport.scrollTop = Math.max(0, top);
    this.#scrollTop = els.viewport.scrollTop;
    this.#scope.graph.scrollTop = this.#scrollTop;
    this.invalidate();
  }

  #applySizer(write = true): void {
    const els = this.#els;
    if (!els) return;
    this.#rowCount = this.rowCount;
    const map = scrollMapping(this.#rowCount + this.#off);
    this.#scale = map.scale;
    const h = Math.max(map.height, this.#h);
    if (write && h !== this.#physH) {
      this.#physH = h;
      els.sizer.style.height = `${h}px`;
    }
  }

  /** Scrolls to the real row line `row` (loaded). `nearest`: minimum (keyboard); `center`: search, sidebar. */
  scrollToRow(row: number, align: 'nearest' | 'center'): void {
    this.#applySizer();
    const vrows = this.#rowCount + this.#off;
    const target = scrollToVrow(row + this.#off, this.#vTop, this.#h, vrows, align);
    if (target !== this.#vTop) this.#setScrollTop(target / this.#scale);
  }

  /** Scroll the viewport of `rows` lines (PageUp / PageDown: a page), bounded to content. */
  scrollByRows(rows: number): void {
    this.#applySizer();
    const maxTop = Math.max(0, (this.#rowCount + this.#off) * ROW_H - this.#h);
    const target = Math.min(maxTop, Math.max(0, this.#vTop + rows * ROW_H));
    if (target !== this.#vTop) this.#setScrollTop(target / this.#scale);
  }

  /** Makes the `row` row visible: load its page by `startRow` if it is not, then scroll. */
  async jumpToRow(row: number, align: 'nearest' | 'center' = 'center'): Promise<boolean> {
    if (row >= 0 && !findPage(this.#scope.graph.pages, row)) {
      const ok = await this.#loadAt({ kind: 'startRow', startRow: Math.floor(row / PAGE_LIMIT) * PAGE_LIMIT, limit: PAGE_LIMIT }, row);
      if (!ok) return false;
    }
    this.scrollToRow(row, align);
    return true;
  }

  /** Load a page on request (saut) and publish it; `center`: rank to keep in memory during eviction. */
  async #loadAt(req: LoadRequest | { kind: 'around'; oid: string }, center: number): Promise<boolean> {
    const repoId = this.#scope.session.repoId;
    if (repoId === null) return false;
    const gen = this.#scope.session.gen;
    this.pagesLoading = true;
    const end = beginActivity('graph:jump');
    this.#requests[req.kind === 'around' ? 'around' : req.kind === 'startRow' ? 'startRow' : 'cursor']++;
    try {
      const args =
        req.kind === 'around'
          ? { repoId, cursor: null, aroundOid: req.oid }
          : req.kind === 'startRow'
            ? { repoId, cursor: null, startRow: req.startRow, limit: req.limit }
            : { repoId, cursor: req.cursor };
      const page = await commands.logPage(args);
      if (!this.#scope.session.isCurrent(gen) || !this.#mounted) return false;
      if (page.rows.length === 0) {
        this.#scope.graph.noteMeta(page);
        return false;
      }
      const c = req.kind === 'around' ? page.start + Math.max(0, page.rows.findIndex((r) => r.oid === req.oid)) : center;
      const res = this.#scope.graph.addPage(page, c);
      if (res === 'newer') {
        await this.refresh();
        return false;
      }
      return res !== 'stale';
    } catch (e) {
      if (isAppError(e) && e.code === 'STALE') {
        await this.refresh();
        return false;
      }
      this.#scope.reportError(e, { command: 'log_page' });
      return false;
    } finally {
      this.pagesLoading = false;
      end();
      this.#updateMissing();
    }
  }

  /** Selects `oid` and makes it visible, uploading its page (`aroundOid`) if necessary. Sidebar: Simple click on a branch. */
  async reveal(oid: string): Promise<void> {
    this.#scope.graph.selectCommit(oid);
    let row = this.#pv().rowOf(oid);
    if (row < 0) {
      const ok = await this.#loadAt({ kind: 'around', oid }, 0);
      if (!ok) {
        // Epoch more recent: the reloaded page may contain the oid.
        row = this.#pv().rowOf(oid);
        if (row < 0) return;
      }
      row = this.#pv().rowOf(oid);
    }
    if (row >= 0) {
      this.#scope.graph.noteRow(oid, row);
      this.cursorRow = row;
      this.anchorRow = row;
      this.scrollToRow(row, 'center');
    }
  }

  /** Makes a commit visible (page loaded by `aroundOid` if needed, centered scroll) without changes the selection. */
  async scrollToOid(oid: string): Promise<void> {
    let row = this.#pv().rowOf(oid);
    if (row < 0) {
      await this.#loadAt({ kind: 'around', oid }, 0);
      row = this.#pv().rowOf(oid);
    }
    if (row >= 0) this.scrollToRow(row, 'center');
  }

  /** Search result: selection + page loaded by `startRow` + centered scrolling. */
  async goToMatch(m: LogMatch): Promise<void> {
    this.#scope.graph.selectCommit(m.oid);
    this.#scope.graph.noteRow(m.oid, m.row);
    this.cursorRow = m.row;
    this.anchorRow = m.row;
    await this.jumpToRow(m.row, 'center');
  }

  /** `End` when `total` is still unknown: a very large `startRow` awaits the end of the index and brings back the total. */
  async resolveTotal(): Promise<number | null> {
    if (this.#scope.graph.total !== null) return this.#scope.graph.total;
    const repoId = this.#scope.session.repoId;
    if (repoId === null) return null;
    this.pagesLoading = true;
    this.#requests.probe++;
    try {
      const page = await commands.logPage({ repoId, cursor: null, startRow: 1_000_000_000, limit: 1 });
      this.#scope.graph.noteMeta(page);
    } catch (e) {
      this.#scope.reportError(e, { command: 'log_page' });
    } finally {
      this.pagesLoading = false;
    }
    return this.#scope.graph.total;
  }

  #startProbe(): void {
    this.#probeFailed = false;
    this.#probe.start();
  }

  // "Refreshment by oid (new epoch) "
  /** `repo:changed { refs | head | stash }`: Rereads the visible page (`aroundOid` = first visible line), the old one remains displayed. */
  refresh(): Promise<void> {
    return this.#refreshing.trigger();
  }

  #captureAnchor(): Anchor {
    const pv = this.#pv();
    return captureAnchor(this.#vTop, this.#off, (row) => {
      for (let r = row; r < row + 200; r++) {
        const x = pv.row(r);
        if (!x) return null;
        if (x.kind === 'commit') return { oid: x.oid, row: r };
      }
      return null;
    });
  }

  async #doRefresh(): Promise<void> {
    const repoId = this.#scope.session.repoId;
    if (repoId === null || !this.#mounted) return;
    const gen = this.#scope.session.gen;
    let anchor = this.#captureAnchor();
    let page: LogPage;
    this.#requests.refresh++;
    try {
      try {
        page = await commands.logPage({ repoId, cursor: null, ...(anchor.oid && !anchor.top ? { aroundOid: anchor.oid } : {}) });
      } catch (e) {
        if (!(isAppError(e) && e.code === 'NOT_FOUND' && anchor.oid)) throw e;
        // The commit can no longer be reached: first page, empty selection (04 "In error cases").
        this.#scope.graph.clearSelection();
        anchor = { oid: null, offset: 0, top: true };
        page = await commands.logPage({ repoId, cursor: null });
      }
    } catch (e) {
      // A failed rereading keeps the old page displayed; the error is reported (NOT_FOUND workdir → dedicated screen, without toast).
      this.#scope.reportError(e, { command: 'log_page' });
      return;
    }
    if (!this.#scope.session.isCurrent(gen) || !this.#mounted) return;
    this.#scope.graph.setPages([page]); // replaces at once: the old page has remained displayed so far (no empty flash)
    this.#loader.reset();
    this.#rev++;
    const v = restoreAnchor(anchor, this.#off, (oid) => this.#pv().rowOf(oid));
    this.#applySizer();
    if (v !== null) this.#setScrollTop(v / this.#scale);
    else this.#setScrollTop(0);
    // The keyboard cursor and anchor return their rank by oid.
    const s = this.#scope.graph.selection;
    if (s.kind === 'commits') {
      const a = this.#pv().rowOf(s.anchor);
      this.anchorRow = a >= 0 ? a : null;
      const last = this.#pv().rowOf(s.oids[s.oids.length - 1]!);
      this.cursorRow = last >= 0 ? last : null;
      for (const oid of s.oids) {
        const r = this.#pv().rowOf(oid);
        if (r >= 0) this.#scope.graph.noteRow(oid, r);
      }
    }
    if (this.#scope.graph.total === null) this.#startProbe();
    if (this.#scope.graph.searchOpen && this.search.query.trim() !== '') this.search.restart();
    this.invalidate();
  }

  // ── Chargement

  async #fetchPage(req: LoadRequest): Promise<LogPage> {
    const repoId = this.#scope.session.repoId;
    if (repoId === null) throw new Error("No repository open");
    this.#requests[req.kind === 'cursor' ? 'cursor' : 'startRow']++;
    return req.kind === 'cursor'
      ? commands.logPage({ repoId, cursor: req.cursor })
      : commands.logPage({ repoId, cursor: null, startRow: req.startRow, limit: req.limit });
  }

  #centerRow(): number {
    return Math.max(0, Math.round((this.#win.firstVisible + this.#win.lastVisible) / 2) - this.#off);
  }

  #updateMissing(): void {
    const w = this.#win;
    const pv = this.#pv();
    let missing = false;
    const first = Math.max(0, w.firstVisible - this.#off);
    const last = Math.min(w.lastVisible - this.#off, this.#rowCount - 1);
    for (let r = first; r <= last; r++) {
      if (!pv.page(r)) {
        missing = true;
        break;
      }
    }
    const v = missing && (this.pagesLoading || this.#scope.graph.loading);
    if (v !== this.missingVisible) this.missingVisible = v;
  }

  // ── Rendu

  #applyColumns(): void {
    const els = this.#els;
    if (!els) return;
    const cols = columnLayout(this.#w, this.#scope.graph.maxLanes);
    this.#params.graphX = cols.graphX;
    this.#params.graphW = cols.graph;
    const prev = this.columns;
    if (prev.refs !== cols.refs || prev.graph !== cols.graph || prev.author !== cols.author || prev.date !== cols.date || prev.sha !== cols.sha) {
      this.columns = cols;
      const st = els.root.style;
      st.setProperty('--c-refs', `${cols.refs}px`);
      st.setProperty('--c-graph', `${cols.graph}px`);
      st.setProperty('--c-author', `${cols.author}px`);
      st.setProperty('--c-date', `${cols.date}px`);
      st.setProperty('--c-sha', `${cols.sha}px`);
      // Masked column (near zone): its cell remains in the grid (width 0, no margin) so as not to shift the following.
      els.root.toggleAttribute('data-no-author', cols.author === 0);
      els.root.toggleAttribute('data-no-date', cols.date === 0);
      els.root.toggleAttribute('data-no-sha', cols.sha === 0);
    }
    const hidden = hiddenLanes(this.#scope.graph.maxLanes);
    if (hidden !== this.hiddenLaneCount) this.hiddenLaneCount = hidden;
  }

  #drawNow(writeSizer = true): void {
    if (this.#raf) {
      cancelAnimationFrame(this.#raf);
      this.#raf = 0;
    }
    this.#frame(writeSizer);
  }

  #describe(real: number): RowDesc | null {
    if (real === -1) {
      return {
        kind: 'wip', index: -1, oid: '', stashIndex: null, summary: t('graph.wip.title'), author: '', avatar: 0, initials: '', date: '', sha: '',
        color: 0, labels: null, wip: this.#wipCounts, dim: false, label: t('graph.wip.title'), shallow: false, lane: 0,
      };
    }
    const r = this.#view.row(real);
    if (!r) {
      return { kind: 'skeleton', index: real, oid: '', stashIndex: null, summary: '', author: '', avatar: 0, initials: '', date: '', sha: '', color: 0, labels: null, wip: null, dim: false, label: '', shallow: false, lane: 0 };
    }
    const author = this.#view.authorName(real);
    const email = this.#view.authorEmail(real);
    const stash = r.kind === 'stash';
    const summary = stash ? `stash@{${r.stashIndex ?? 0}}: ${r.summary}` : r.summary;
    return {
      kind: stash ? 'stash' : 'commit', index: real, oid: r.oid, stashIndex: r.stashIndex, summary, author,
      avatar: avatarColor(email || author), initials: initials(author), date: formatGraphDate(r.time, this.#now), sha: r.oid.slice(0, 7),
      color: r.color, labels: r.refs.length ? layoutLabels(r.refs, (n) => this.#upstreams.get(n) ?? null) : null, wip: null,
      dim: this.#dim && !this.#reach.isReachable(r), label: `${summary} — ${author} — ${r.oid.slice(0, 7)}`,
      shallow: this.#shallow && r.parents.length === 0 && !stash, lane: r.lane,
    };
  }

  #frame = (writeSizer = true): void => {
    this.#raf = 0;
    const els = this.#els;
    const pool = this.#pool;
    if (!els || !pool || this.#h <= 0 || pool.size === 0) return;
    const t0 = performance.now();

    // Window moved to a different density screen: the resolution of the canvas follows (read `devicePixelRatio`, no layout).
    const ratio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    if (ratio !== this.#dpr) {
      this.#dpr = ratio;
      els.canvas.width = Math.max(1, Math.round(this.#w * ratio));
      els.canvas.height = Math.max(1, Math.round(this.#h * ratio));
    }

    // Data: new page list → view, HEAD, HEAD line of the WIP node, reachability.
    const pages = this.#scope.graph.pages;
    const head = this.#headTarget;
    if (pages !== this.#framePages || head !== this.#headOid) {
      this.#pv();
      this.#framePages = pages;
      this.#headOid = head;
      this.#now = Date.now();
      this.#reach.feed(pages, head, this.#scope.graph.epoch);
      // -3: no HEAD (repository empty: the WIP node is not connected to anything); -2: HEAD outside loaded pages.
      const hr = head ? this.#view.rowOf(head) : -3;
      const hrow = hr >= 0 ? this.#view.row(hr) : null;
      this.#headRow = head && hr < 0 ? -2 : hr;
      this.#headLane = hrow?.lane ?? 0;
      this.#headColor = hrow?.color ?? 0;
      this.#rev++;
    }
    // Width of the Graph column: follows `maxLanes` (which grows with the index, including by a simple probe of `total`).
    if (this.#scope.graph.maxLanes !== this.#lastLanes) {
      this.#lastLanes = this.#scope.graph.maxLanes;
      this.#applyColumns();
    }
    const empty = pages.length > 0 && this.#scope.graph.total === 0;
    if (empty !== this.empty) this.empty = empty;
    const off = this.#off;
    this.#applySizer(writeSizer);
    if (writeSizer && this.#restoreScroll) {
      els.viewport.scrollTop = this.#scrollTop;
      this.#restoreScroll = false;
    }
    const vrows = this.#rowCount + off;
    const maxTop = Math.max(0, vrows * ROW_H - this.#h);
    const dpr = this.#dpr;
    const vTop = Math.min(maxTop, Math.round(this.#scrollTop * this.#scale * dpr) / dpr);
    this.#vTop = vTop;
    const win = rowWindow(vTop, this.#h, pool.size, vrows);
    this.#win = win;

    // Pool DOM: a line `r` occupies the `r mod taille` location; only the lines entered in the window are rewritten.
    const tr = `translateY(${-vTop}px)`;
    if (tr !== this.#rowsTransform) {
      this.#rowsTransform = tr;
      els.rows.style.transform = tr;
    }
    const rev = this.#rev;
    for (let v = win.first; v <= win.last; v++) {
      const slot = pool.slotFor(v);
      const real = v - off;
      const valid = v < vrows;
      if (slot.vrow !== v || slot.rev !== rev) {
        if (slot.vrow !== v) place(slot, v);
        slot.rev = rev;
        const d = valid ? this.#describe(real) : null;
        if (d) bindRow(slot, d);
        else clearRow(slot);
        setSelected(slot, false);
      }
      if (valid) {
        const k = slot.kind;
        const sel = k === 'wip' ? this.#wipSel : k === 'stash' ? slot.oid === this.#stashSel : k === 'commit' ? this.#sel.has(slot.oid) : false;
        if (sel !== slot.selected) setSelected(slot, sel);
      }
    }

    // Accessibility: the focus remains on the viewport, the keyboard cursor line is announced by aria-activedescendant.
    let active = '';
    if (this.cursorRow !== null) {
      const slot = pool.slotFor(this.cursorRow + off);
      if (slot.vrow === this.cursorRow + off && slot.kind !== '') active = slot.el.id;
    }
    if (active !== this.#activeId) {
      this.#activeId = active;
      if (active) els.viewport.setAttribute('aria-activedescendant', active);
      else els.viewport.removeAttribute('aria-activedescendant');
    }

    // Canvas.
    const ctx = this.#ctx;
    let drawn = 0;
    if (ctx && typeof Path2D !== 'undefined') {
      const p = this.#params;
      p.w = this.#w;
      p.h = this.#h;
      p.dpr = dpr;
      p.vTop = vTop;
      p.first = win.first;
      p.last = win.last;
      p.wip = this.#wip;
      p.maxLanes = this.#scope.graph.maxLanes;
      p.rows = this.#view;
      p.rowCount = this.#rowCount;
      p.selected = this.#sel;
      p.stashSelected = this.#stashSel;
      p.wipSelected = this.#wipSel;
      p.hoverRow = this.#hover;
      p.matchRows = this.#matchRows;
      p.headOid = head;
      p.wipLane = this.#headLane;
      p.wipColor = this.#headColor;
      p.headRow = this.#headRow;
      p.palette = this.#palette;
      drawn = draw(ctx, p, () => new Path2D()).rows;
    }
    this.#dt[this.#dtCount++ % DRAW_SAMPLES] = performance.now() - t0;

    // Window rendered (tests) and first display mark (B2).
    const rs = String(win.first - off);
    const re = String(Math.min(win.last, vrows - 1) - off);
    if (els.canvas.getAttribute('data-row-start') !== rs) els.canvas.setAttribute('data-row-start', rs);
    if (els.canvas.getAttribute('data-row-end') !== re) els.canvas.setAttribute('data-row-end', re);
    // B2: "First 60 drawn lines" — or all visible lines when the viewport shows less (or the log is shorter).
    if (!this.#firstPaint && drawn >= Math.min(FIRST_PAINT_ROWS, Math.ceil(this.#h / ROW_H), Math.max(1, this.#rowCount + off))) {
      this.#firstPaint = true;
      perfMark('gitmini:graph-first-paint');
    }

    // Loading: visible and then preloaded (only one flight request, replanned at each turn).
    const key = `${win.first}:${win.last}:${pages.length}:${this.#scope.graph.total}`;
    if (key !== this.#lastEnsureKey) {
      this.#lastEnsureKey = key;
      this.#updateMissing();
      this.#loader.ensure();
    }
  };
}
