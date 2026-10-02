<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { op, ui, wt } = captureStores();
  // A section of `wt-panel`: header (counter, "All..." buttons), virtualized file list from 500 entries,
  // Multiple selection (Maj / Mod + click), keyboard (↑ ▼ s u Delete Enter, 03 " Keyboard").
  import { tick, untrack } from 'svelte';
  import { isMac, isTextInput } from '$lib/actions/shortcuts';
  import { openContextMenu } from '$lib/menus/registry';
  import type { MenuTarget } from '$lib/menus/types';
  import type { FileStatus } from '$lib/ipc/types';

  import { t, tp } from '$i18n/index';
  import { discardAll, discardFiles, isOpenDiff, openFileDiff, openInEditor, resolveConflict, stagePaths, unstagePaths } from './actions';
  import FileRow from './FileRow.svelte';
  import { isWritable, stageable, unstageable, type ListSide } from './list-model';
  import { measureHeight } from './measure';
  import RowIcon from './RowIcon.svelte';
  import { clickSelect, EMPTY_SELECTION, keyboardTargets, moveFocus, neighborAfterRemoval, prune, targetsFor } from './selection';
  import { FALLBACK_VIEWPORT, LIST_ROW_HEIGHT, LIST_VIRTUALIZE_THRESHOLD, windowRange } from './virtual';

  interface Props {
    side: ListSide;
    files: FileStatus[];
    /** `RepoOpState.kind`, ou `none` (conflit d'application de stash) : `data-kind` de `wt-conflict-list`. */
    opKind?: string;
    /** The initial `status_get` has not yet arrived. */
    loading?: boolean;
  }

  let { side, files, opKind = 'none', loading = false }: Props = $props();

  const testid = $derived(side === 'conflict' ? 'wt-conflict-list' : side === 'staged' ? 'wt-staged-list' : 'wt-unstaged-list');
  const title = $derived(t(side === 'conflict' ? 'wt.section.conflicts' : side === 'staged' ? 'wt.section.staged' : 'wt.section.unstaged'));
  const note = $derived(side === 'conflict' ? t(opKind === 'none' ? 'wt.conflicts.stash' : 'wt.conflicts.op') : null);

  const paths = $derived(files.map((f) => f.path));
  const sel = $derived(wt.selections[side]);
  const locked = $derived(op.busy);

  let scroller = $state<HTMLDivElement>();
  let scrollTop = $state(0);
  let viewport = $state(0);
  let pointerDown = false;

  const virtual = $derived(files.length >= LIST_VIRTUALIZE_THRESHOLD);
  const win = $derived(virtual ? windowRange({ scrollTop, viewport, rowHeight: LIST_ROW_HEIGHT, count: files.length }) : { first: 0, end: files.length });
  const visible = $derived(files.slice(win.first, win.end));
  const focusIndex = $derived(sel.focus === null ? -1 : paths.indexOf(sel.focus));

  // Paths that are no longer listed (file staged, display, external modification) are removed from the selection.
  $effect(() => {
    const current = untrack(() => wt.selections[side]);
    const next = prune(current, paths);
    if (next !== current) wt.replace(side, next);
  });

  function filesOf(ps: readonly string[]): FileStatus[] {
    const set = new Set(ps);
    return files.filter((f) => set.has(f.path));
  }

  function writableOf(ps: readonly string[]): FileStatus[] {
    return filesOf(ps).filter(isWritable);
  }

  function reveal(path: string): void {
    const i = paths.indexOf(path);
    const el = scroller;
    if (i < 0 || !el) return;
    const top = i * LIST_ROW_HEIGHT;
    const h = el.clientHeight || FALLBACK_VIEWPORT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + LIST_ROW_HEIGHT > el.scrollTop + h) el.scrollTop = top + LIST_ROW_HEIGHT - h;
    scrollTop = el.scrollTop;
  }

  // ── Souris
  function onselect(e: MouseEvent, file: FileStatus): void {
    const toggle = isMac() ? e.metaKey : e.ctrlKey;
    const next = clickSelect(sel, paths, file.path, { shift: e.shiftKey, toggle });
    wt.select(side, next);
    scroller?.focus({ preventScroll: true });
    // A simple click opens the diff; Shift / Mod + click only select.
    if (!e.shiftKey && !toggle) openFileDiff(file, side);
  }

  function menuFor(file: FileStatus): () => MenuTarget | null {
    return () => {
      const current = wt.selections[side];
      if (!current.paths.has(file.path)) wt.select(side, clickSelect(EMPTY_SELECTION, paths, file.path));
      const chosen = filesOf([...wt.selections[side].paths]);
      return { menu: 'wt-file', file, files: chosen.length > 0 ? chosen : [file] };
    };
  }

  function rowTargets(file: FileStatus): string[] {
    return targetsFor(sel, paths, file.path);
  }

  function rowStage(file: FileStatus): void {
    void stagePaths(writableOf(rowTargets(file)).map((f) => f.path));
  }
  function rowUnstage(file: FileStatus): void {
    void unstagePaths(writableOf(rowTargets(file)).map((f) => f.path));
  }
  function rowDiscard(file: FileStatus): void {
    void discardFiles(writableOf(rowTargets(file)));
  }

  // ── Clavier
  /** After writing to the keyboard, the focus goes to the next file: `s`, `s`, `s` can be chained. */
  async function keyboardWrite(kind: 'stage' | 'unstage' | 'discard'): Promise<void> {
    const targets = writableOf(keyboardTargets(sel, paths));
    if (targets.length === 0) return;
    const ps = targets.map((f) => f.path);
    const before = paths;
    const ok = kind === 'stage' ? await stagePaths(ps) : kind === 'unstage' ? await unstagePaths(ps) : await discardFiles(targets);
    if (!ok) return;
    await tick();
    const neighbor = neighborAfterRemoval(before, paths, ps);
    wt.select(side, neighbor ? { paths: new Set(), anchor: neighbor, focus: neighbor } : EMPTY_SELECTION);
    if (neighbor) reveal(neighbor);
  }

  function onkeydown(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.isComposing || isTextInput(e.target)) return;
    const mod = e.metaKey || e.ctrlKey;

    if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') {
      const file = filesOf(keyboardTargets(sel, paths))[0] ?? files[0];
      if (!file || !scroller) return;
      e.preventDefault();
      const r = scroller.getBoundingClientRect();
      const target = menuFor(file)();
      if (target) openContextMenu(target, r.left + 24, r.top + 24, scroller);
      return;
    }
    if (mod && e.key.toLowerCase() === 'a') {
      if (paths.length === 0) return;
      e.preventDefault();
      wt.select(side, { paths: new Set(paths), anchor: paths[0]!, focus: paths[paths.length - 1]! });
      return;
    }
    if (e.altKey || mod) return;

    let move: number | 'home' | 'end' | null = null;
    switch (e.key) {
      case 'ArrowDown':
        move = 1;
        break;
      case 'ArrowUp':
        move = -1;
        break;
      case 'PageDown':
        move = Math.max(1, Math.floor((scroller?.clientHeight || FALLBACK_VIEWPORT) / LIST_ROW_HEIGHT) - 1);
        break;
      case 'PageUp':
        move = -Math.max(1, Math.floor((scroller?.clientHeight || FALLBACK_VIEWPORT) / LIST_ROW_HEIGHT) - 1);
        break;
      case 'Home':
        move = 'home';
        break;
      case 'End':
        move = 'end';
        break;
    }
    if (move !== null) {
      e.preventDefault();
      const next = moveFocus(sel, paths, move, e.shiftKey);
      wt.select(side, next);
      if (next.focus) reveal(next.focus);
      return;
    }

    if (e.shiftKey) return;
    if (e.key === 'Enter') {
      const file = filesOf(keyboardTargets(sel, paths))[0];
      if (!file) return;
      e.preventDefault();
      openFileDiff(file, side);
    } else if (e.key === 's' && side === 'unstaged') {
      e.preventDefault();
      void keyboardWrite('stage');
    } else if (e.key === 'u' && side === 'staged') {
      e.preventDefault();
      void keyboardWrite('unstage');
    } else if (e.key === 'Delete' && side === 'unstaged') {
      e.preventDefault();
      void keyboardWrite('discard');
    }
  }

  function onfocus(): void {
    // Arrival on the keyboard (Tab, Mod+3): the first file becomes the focused file, so that `s` / `u` will act immediately.
    if (pointerDown || sel.focus !== null || files.length === 0) return;
    const first = paths[0]!;
    wt.select(side, { paths: new Set(), anchor: first, focus: first });
  }

  const stageAllCount = $derived(stageable(files).length);
  const unstageAllCount = $derived(unstageable(files).length);
  const activeId = $derived(focusIndex >= win.first && focusIndex < win.end ? `wt-${side}-${focusIndex}` : undefined);
</script>

<section class="section" class:conflict={side === 'conflict'} data-testid={testid} data-count={files.length} data-kind={side === 'conflict' ? opKind : undefined} data-virtual={virtual ? 'true' : undefined}>
  <header>
    <h3>{title}</h3>
    <span class="count" aria-label={tp('wt.files', files.length)}>{files.length}</span>
    <span class="spacer"></span>
    {#if side === 'unstaged'}
      <button type="button" class="hbtn danger" data-testid="wt-discard-all-btn" disabled={locked || stageAllCount === 0} title={t('wt.btn.discardAll')} onclick={() => void discardAll()}>
        <RowIcon name="discard" size={12} />{t('wt.btn.discardAll')}
      </button>
      <button type="button" class="hbtn" data-testid="wt-stage-all-btn" disabled={locked || stageAllCount === 0} title={t('wt.btn.stageAll')} onclick={() => void stagePaths('all')}>
        <RowIcon name="stage" size={12} />{t('wt.btn.stageAll')}
      </button>
    {:else if side === 'staged'}
      <button type="button" class="hbtn" data-testid="wt-unstage-all-btn" disabled={locked || unstageAllCount === 0} title={t('wt.btn.unstageAll')} onclick={() => void unstagePaths('all')}>
        <RowIcon name="unstage" size={12} />{t('wt.btn.unstageAll')}
      </button>
    {/if}
  </header>
  {#if note}<p class="note muted">{note}</p>{/if}

  <div
    bind:this={scroller}
    use:measureHeight={(h) => (viewport = h)}
    class="scroller"
    role="listbox"
    tabindex={files.length > 0 ? 0 : -1}
    aria-label={title}
    aria-multiselectable="true"
    aria-activedescendant={activeId}
    data-zone-focus={files.length > 0 ? '' : undefined}
    data-roving-list={side}
    onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)}
    onpointerdown={() => (pointerDown = true)}
    onpointerup={() => (pointerDown = false)}
    onpointercancel={() => (pointerDown = false)}
    {onkeydown}
    {onfocus}
  >
    {#if files.length === 0}
      <p class="empty muted">{loading ? t('wt.loading') : side === 'staged' ? t('wt.empty.staged') : t('wt.empty.unstaged')}</p>
    {:else}
      <div class="sizer" class:virtual style:height={virtual ? `${files.length * LIST_ROW_HEIGHT}px` : undefined}>
        {#each visible as file, i (file.path)}
          {@const index = win.first + i}
          <FileRow
            {file}
            {side}
            {index}
            top={virtual ? index * LIST_ROW_HEIGHT : undefined}
            selected={sel.paths.has(file.path)}
            focused={sel.focus === file.path}
            open={isOpenDiff(file.path, side) && !ui.centerIsGraph}
            pending={wt.pending.includes(file.path)}
            {locked}
            targets={sel.paths.has(file.path) ? sel.paths.size : 1}
            menuTarget={menuFor(file)}
            onselect={(e) => onselect(e, file)}
            onstage={() => rowStage(file)}
            onunstage={() => rowUnstage(file)}
            ondiscard={() => rowDiscard(file)}
            onresolve={() => void resolveConflict(file.path)}
            onopen={() => void openInEditor(file.path)}
          />
        {/each}
      </div>
    {/if}
  </div>
</section>

<style>
  .section {
    display: flex;
    flex-direction: column;
    flex: 1 1 0;
    min-height: 88px;
    border-bottom: 1px solid var(--border);
  }
  .section.conflict {
    flex: 0 1 auto;
    max-height: 45%;
    min-height: 0;
    background: var(--bg-elev);
  }
  /* Conflicts take up the height of their content (and then scroll); the other lists share the rest. */
  .section.conflict .scroller {
    flex: 0 1 auto;
  }
  header {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 8px;
    background: var(--bg-elev);
    border-bottom: 1px solid var(--border);
  }
  h3 {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--fg-muted);
  }
  .count {
    padding: 0 6px;
    border-radius: 999px;
    background: var(--border);
    font-size: 11px;
    line-height: 16px;
  }
  .spacer {
    flex: 1;
  }
  .hbtn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding: 0 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    font-size: 11px;
    white-space: nowrap;
  }
  .hbtn:hover:not(:disabled) {
    background: var(--row-hover);
  }
  .hbtn:disabled {
    opacity: 0.45;
  }
  .hbtn.danger:hover:not(:disabled) {
    border-color: var(--danger);
    color: var(--danger);
  }
  .note {
    flex: none;
    margin: 0;
    padding: 6px 10px;
    font-size: 12px;
    border-bottom: 1px solid var(--border);
  }
  .scroller {
    flex: 1 1 0;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .scroller:focus-visible {
    box-shadow: inset 0 0 0 1px var(--accent);
    border-radius: 0;
  }
  .sizer.virtual {
    position: relative;
  }
  .empty {
    margin: 0;
    padding: 10px 12px;
    font-size: 12px;
  }
</style>
