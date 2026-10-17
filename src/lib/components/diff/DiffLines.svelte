<script lang="ts">
  // diff Unified List (05): hunk headers (stage/unstage/discard buttons) and 20 px lines, virtualized from
  // 2,000 lines . A line window is returned in a container staggered by `translateY` ; the total height comes from the calculation
  // positions of `diff-layout.ts`: no layout reading in the rendering.
  // Intra-line highlighting (DIFF-05): in a removed line and its added counterpart the characters that changed are marked
  // (`layout.marks`), on top of the whole-line colour.
  // Line selection (STAGE-10): the gutter of an added / removed line toggles it, Shift+click selects a range, Cmd / Ctrl+click
  // toggles; while lines of a hunk are selected, its header offers the actions for those lines instead of the whole hunk.
  import { isMac } from '$lib/actions/shortcuts';
  import { t, tp } from '$i18n/index';
  import RowIcon from '../wt/RowIcon.svelte';
  import { measureHeight } from '../wt/measure';
  import { windowFromTops } from '../wt/virtual';
  import { HEADER_HEIGHT, LINE_HEIGHT, type DiffLayout, type LineRow } from './diff-layout';
  import { segments } from './intraline';
  import { isChange, type LineSelection, type PickMods } from './line-select';

  interface Props {
    layout: DiffLayout;
    /** `DiffSource.kind`: decides the hunk buttons. */
    sourceKind: string;
    /** hunk enabled buttons (text, no conflict, no submodule, no UTF-8). */
    canHunk: boolean;
    /** A handwriting is in flight: the buttons are disabled. */
    locked: boolean;
    focusedHunk: number | null;
    onfocushunk: (index: number) => void;
    onhunk: (kind: 'stage' | 'unstage' | 'discard', index: number) => void;
    /** Selected lines (one hunk), `null` for none. */
    selection: LineSelection | null;
    onpick: (hunk: number, line: number, mods: PickMods) => void;
    /** Acts on the selected lines. */
    onlines: (kind: 'stage' | 'unstage' | 'discard') => void;
    onclear: () => void;
    /** Scroll request up (new diff). */
    resetKey: unknown;
  }

  let { layout, sourceKind, canHunk, locked, focusedHunk, onfocushunk, onhunk, selection, onpick, onlines, onclear, resetKey }: Props = $props();

  let scroller = $state<HTMLDivElement>();
  let scrollTop = $state(0);
  let viewport = $state(0);

  const win = $derived(
    layout.virtual ? windowFromTops({ tops: layout.tops, scrollTop, viewport }) : { first: 0, end: layout.rows.length },
  );
  const rows = $derived(layout.rows.slice(win.first, win.end));
  const offset = $derived(layout.virtual && layout.rows.length > 0 ? (layout.tops[win.first] ?? 0) : 0);

  // Another file (or another view): back to the top.
  let lastKey: unknown = undefined;
  $effect(() => {
    const k = resetKey;
    if (k !== lastKey) {
      lastKey = k;
      if (scroller) scroller.scrollTop = 0;
      scrollTop = 0;
    }
  });

  const SIGN = { ctx: ' ', add: '+', del: '−', noeol: '' } as const;

  /** Scrolls row `index` (position in `layout.rows`) into view: the keyboard moves the selection through lines that may be outside the window. */
  export function reveal(index: number): void {
    const el = scroller;
    const top = layout.tops[index];
    if (!el || top === undefined) return;
    const height = layout.rows[index]?.type === 'hunk' ? HEADER_HEIGHT : LINE_HEIGHT;
    const view = el.clientHeight || viewport;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (view > 0 && top + height > el.scrollTop + view) el.scrollTop = top + height - view;
    scrollTop = el.scrollTop;
  }

  function isPicked(row: LineRow): boolean {
    return selection !== null && selection.hunk === row.hunkIndex && selection.lines.has(row.lineIndex);
  }

  // Click on a line: a modifier or the gutter picks it; a click on the text only focuses its hunk and drops the selection.
  function onlineclick(e: MouseEvent, row: LineRow): void {
    const toggle = isMac() ? e.metaKey : e.ctrlKey;
    const gutter = e.target instanceof Element && e.target.closest('[data-gutter]') !== null;
    if (canHunk && isChange(row.kind) && (e.shiftKey || toggle || gutter)) {
      onpick(row.hunkIndex, row.lineIndex, { shift: e.shiftKey, toggle: toggle || (gutter && !e.shiftKey) });
      scroller?.focus({ preventScroll: true });
      return;
    }
    onfocushunk(row.hunkIndex);
    if (selection !== null) onclear();
  }

  // Shift+mousedown would extend the browser's own text selection across the code.
  function onlinedown(e: MouseEvent): void {
    if (e.shiftKey && canHunk) e.preventDefault();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  bind:this={scroller}
  use:measureHeight={(h) => (viewport = h)}
  class="scroller"
  role="region"
  aria-label={t(`diff.source.${sourceKind}`)}
  tabindex="0"
  data-zone-focus
  data-virtual={layout.virtual ? 'true' : undefined}
  data-row-count={layout.rows.length}
  onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)}
>
  <div class="sizer" style:height="{layout.total}px" style:min-width="calc(112px + {layout.maxCols}ch)">
    <div class="window" style:transform={offset ? `translateY(${offset}px)` : undefined}>
      {#each rows as row, k (win.first + k)}
        {#if row.type === 'hunk'}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div
            class="hunk"
            class:focused={focusedHunk === row.hunkIndex}
            data-testid="diff-hunk-header"
            data-hunk-index={row.hunkIndex}
            onclick={() => onfocushunk(row.hunkIndex)}
            onfocusin={() => onfocushunk(row.hunkIndex)}
          >
            <code class="htext" data-testid="diff-hunk-header-text">{row.header}</code>
            {#if canHunk}
              <span class="hbtns">
                {#if selection !== null && selection.hunk === row.hunkIndex}
                  {@const n = selection.lines.size}
                  <span class="count muted" data-testid="diff-lines-count">{tp('diff.lines.selected', n)}</span>
                  {#if sourceKind === 'unstaged'}
                    <button type="button" class="hbtn" data-testid="diff-lines-stage-btn" disabled={locked} onclick={() => onlines('stage')}>
                      <RowIcon name="stage" size={12} />{tp('diff.lines.stage', n)}
                    </button>
                    <button type="button" class="hbtn danger" data-testid="diff-lines-discard-btn" disabled={locked} onclick={() => onlines('discard')}>
                      <RowIcon name="discard" size={12} />{tp('diff.lines.discard', n)}
                    </button>
                  {:else if sourceKind === 'staged'}
                    <button type="button" class="hbtn" data-testid="diff-lines-unstage-btn" disabled={locked} onclick={() => onlines('unstage')}>
                      <RowIcon name="unstage" size={12} />{tp('diff.lines.unstage', n)}
                    </button>
                  {/if}
                  <button type="button" class="hbtn icon" data-testid="diff-lines-clear-btn" title={t('diff.lines.clear')} aria-label={t('diff.lines.clear')} onclick={onclear}>
                    <RowIcon name="close" size={12} />
                  </button>
                {:else if sourceKind === 'unstaged'}
                  <button type="button" class="hbtn" data-testid="diff-hunk-stage-btn" disabled={locked} onclick={() => onhunk('stage', row.hunkIndex)}>
                    <RowIcon name="stage" size={12} />{t('diff.hunk.stage')}
                  </button>
                  <button type="button" class="hbtn danger" data-testid="diff-hunk-discard-btn" disabled={locked} onclick={() => onhunk('discard', row.hunkIndex)}>
                    <RowIcon name="discard" size={12} />{t('diff.hunk.discard')}
                  </button>
                {:else if sourceKind === 'staged'}
                  <button type="button" class="hbtn" data-testid="diff-hunk-unstage-btn" disabled={locked} onclick={() => onhunk('unstage', row.hunkIndex)}>
                    <RowIcon name="unstage" size={12} />{t('diff.hunk.unstage')}
                  </button>
                {/if}
              </span>
            {/if}
          </div>
        {:else}
          {@const marks = row.marker ? null : layout.marks(win.first + k)}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div
            class="line"
            class:marker={row.marker}
            class:pickable={canHunk && isChange(row.kind)}
            class:picked={isPicked(row)}
            data-testid="diff-line"
            data-kind={row.kind}
            data-old-no={row.oldNo ?? undefined}
            data-new-no={row.newNo ?? undefined}
            data-crlf={row.crlf ? 'true' : undefined}
            data-selected={isPicked(row) ? 'true' : undefined}
            onclick={(e) => onlineclick(e, row)}
            onmousedown={onlinedown}
          >
            <span class="gutter" data-gutter data-testid="diff-line-gutter" title={canHunk && isChange(row.kind) ? t('diff.lines.pick') : undefined}><span class="no">{row.oldNo ?? ''}</span><span class="no">{row.newNo ?? ''}</span><span class="sign">{SIGN[row.kind]}</span></span>
            <span class="text" data-testid="diff-line-text">{#if row.marker}<span data-testid="diff-conflict-marker">{row.text}</span>{:else if marks}{#each segments(row.text, marks) as seg, s (s)}{#if seg.changed}<span class="chg" data-testid="diff-intraline">{seg.text}</span>{:else}{seg.text}{/if}{/each}{:else}{row.text}{/if}{#if row.truncatedFrom !== null}<span class="cut muted">{t('diff.truncatedLine', { n: row.truncatedFrom })}</span>{/if}</span>
          </div>
        {/if}
      {/each}
    </div>
  </div>
</div>

<style>
  .scroller {
    flex: 1 1 0;
    min-height: 0;
    overflow: auto;
    font: 12px/20px var(--font-mono);
    tab-size: 4;
    background: var(--bg);
  }
  .scroller:focus-visible {
    box-shadow: inset 0 0 0 1px var(--accent);
    border-radius: 0;
  }
  .sizer {
    position: relative;
    width: 100%;
  }
  .window {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    will-change: transform;
  }
  .hunk {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 26px;
    padding: 0 8px;
    background: var(--bg-elev);
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    color: var(--fg-muted);
    font-family: var(--font-mono);
    white-space: nowrap;
  }
  .hunk.focused {
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .htext {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .hbtns {
    position: sticky;
    right: 8px;
    margin-left: auto;
    display: inline-flex;
    gap: 4px;
    flex: none;
  }
  .hbtn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 20px;
    padding: 0 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--fg);
    font: 11px var(--font-ui);
  }
  .hbtn:hover:not(:disabled) {
    background: var(--row-hover);
  }
  .hbtn.icon {
    padding: 0 4px;
  }
  .count {
    align-self: center;
    font: 11px var(--font-ui);
  }
  .hbtn:disabled {
    opacity: 0.45;
  }
  .hbtn.danger:hover:not(:disabled) {
    border-color: var(--danger);
    color: var(--danger);
  }
  .line {
    display: flex;
    height: 20px;
    white-space: pre;
  }
  .line[data-kind='add'] {
    background: var(--diff-add-bg);
  }
  .line[data-kind='del'] {
    background: var(--diff-del-bg);
  }
  .chg {
    border-radius: 2px;
  }
  .line[data-kind='add'] .chg {
    background: var(--diff-add-word-bg);
  }
  .line[data-kind='del'] .chg {
    background: var(--diff-del-word-bg);
  }
  /* Forced colors drop backgrounds: the changed characters are underlined instead. */
  @media (forced-colors: active) {
    .chg {
      text-decoration: underline;
    }
  }
  .gutter {
    flex: none;
    display: flex;
  }
  .line.pickable .gutter {
    cursor: pointer;
  }
  .line.pickable .gutter:hover {
    background: var(--row-hover);
  }
  .line.picked {
    box-shadow: inset 3px 0 0 var(--accent);
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }
  .line.picked .gutter {
    background: var(--row-selected);
  }
  .line[data-kind='noeol'] {
    color: var(--fg-muted);
    font-style: italic;
  }
  .line.marker {
    border-left: 3px solid var(--warn);
    background: var(--bg-elev);
    font-weight: 600;
  }
  .no {
    flex: none;
    width: 48px;
    padding-right: 8px;
    text-align: right;
    color: var(--fg-muted);
    user-select: none;
  }
  .sign {
    flex: none;
    width: 16px;
    text-align: center;
    color: var(--fg-muted);
    user-select: none;
  }
  .text {
    flex: 1 0 auto;
  }
  .line[data-crlf='true'] .text::after {
    content: '␍';
    margin-left: 1ch;
    color: var(--fg-muted);
    opacity: 0.35;
  }
  .cut {
    font-style: italic;
    margin-left: 0.5ch;
  }
</style>
