<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { reportError, session } = captureStores();
  // The file at one commit, every line annotated with the commit that last changed it (`file_blame`). Runs of lines from the same
  // commit share one annotation (short sha, author, age); picking it hands the commit back to the history view, which shows what
  // that commit changed. Virtualized (fixed-height lines). Keyboard: the text area is focusable, Arrow keys, Page keys, Home and End
  // move a line cursor, Enter picks the commit behind the line; the line under the cursor is announced.
  import { untrack } from 'svelte';
  import { commands } from '$lib/ipc/commands';
  import type { AppError, FileBlame } from '$lib/ipc/types';
  import { formatBytes } from '../../diff/diff-layout';
  import { measureHeight } from '../../wt/measure';
  import { windowRange } from '../../wt/virtual';
  import { t } from '$i18n/index';
  import Spinner from '$lib/components/ui/Spinner.svelte';
  import { annotation, annotationTitle, BLAME_LINE_HEIGHT, blameRows, lineAnnouncement, lineOrigin, stepLine } from './blame-logic';

  interface Props {
    path: string;
    /** Commit to read the file from. */
    rev: string;
    /** A run's annotation was picked: the commit, and the file's name in it. */
    onpick: (oid: string, path: string) => void;
  }

  let { path, rev, onpick }: Props = $props();

  let blame = $state.raw<FileBlame | null>(null);
  let loading = $state(true);
  let forcing = $state(false);
  let loadError = $state.raw<AppError | null>(null);
  let scroller = $state<HTMLDivElement>();
  let scrollTop = $state(0);
  let viewport = $state(0);
  /** The line the keyboard is on (1-based), `null` before it moved. */
  let cursor = $state<number | null>(null);
  let seq = 0;

  const rows = $derived(blame ? blameRows(blame) : []);
  const win = $derived(windowRange({ scrollTop, viewport, rowHeight: BLAME_LINE_HEIGHT, count: rows.length }));
  const visible = $derived(rows.slice(win.first, win.end));
  const now = $derived.by(() => {
    void blame; // the ages are read when the blame arrives
    return Date.now();
  });
  const announcement = $derived(blame && cursor !== null ? lineAnnouncement(blame, cursor, now) : '');

  async function load(force = false): Promise<void> {
    const repoId = session.repoId;
    if (repoId === null) return;
    const gen = session.gen;
    const mine = ++seq;
    if (force) forcing = true;
    else {
      loading = true;
      blame = null;
      cursor = null;
    }
    loadError = null;
    try {
      const b = await commands.fileBlame({ repoId, path, rev, ...(force ? { force: true } : {}) });
      if (mine !== seq || !session.isCurrent(gen)) return;
      blame = b;
    } catch (e) {
      if (mine !== seq) return;
      loadError = reportError(e, { command: 'file_blame', quiet: true });
    } finally {
      if (mine === seq) {
        loading = false;
        forcing = false;
      }
    }
  }

  // Another file or commit: start over, from the top.
  $effect(() => {
    void path;
    void rev;
    untrack(() => {
      if (scroller) scroller.scrollTop = 0;
      scrollTop = 0;
      void load();
    });
  });

  function pick(line: number): void {
    if (!blame) return;
    const origin = lineOrigin(blame, line);
    if (origin) onpick(origin.commit.oid, origin.path);
  }

  /** Brings `line` into view (the cursor can leave the rendered window). */
  function reveal(line: number): void {
    const el = scroller;
    if (!el) return;
    const top = (line - 1) * BLAME_LINE_HEIGHT;
    const view = el.clientHeight || viewport;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (view > 0 && top + BLAME_LINE_HEIGHT > el.scrollTop + view) el.scrollTop = top + BLAME_LINE_HEIGHT - view;
    scrollTop = el.scrollTop;
  }

  function onkeydown(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !blame) return;
    const count = rows.length;
    const page = Math.max(1, Math.floor((viewport || 400) / BLAME_LINE_HEIGHT) - 1);
    let next: number | null | undefined;
    if (e.key === 'ArrowDown') next = stepLine(cursor, 1, count);
    else if (e.key === 'ArrowUp') next = stepLine(cursor, -1, count);
    else if (e.key === 'PageDown') next = stepLine(cursor, page, count);
    else if (e.key === 'PageUp') next = stepLine(cursor, -page, count);
    else if (e.key === 'Home') next = count > 0 ? 1 : null;
    else if (e.key === 'End') next = count > 0 ? count : null;
    else if (e.key === 'Enter' && cursor !== null) {
      e.preventDefault();
      pick(cursor);
      return;
    }
    if (next === undefined) return;
    e.preventDefault();
    cursor = next;
    if (next !== null) reveal(next);
  }
</script>

<div class="blame" data-testid="file-blame" data-path={path} data-rev={rev} data-state={loading ? 'loading' : loadError ? 'error' : blame?.binary ? 'binary' : blame?.tooLarge ? 'large' : 'ready'}>
  {#if loading}
    <div class="state muted" data-testid="file-blame-loading"><Spinner size={14} /> <span>{t('blame.loading')}</span></div>
  {:else if loadError}
    <div class="state" data-testid="file-blame-error">
      <p>{t('blame.error')}</p>
      <p class="muted">{loadError.message}</p>
      <button type="button" class="btn" data-testid="file-blame-retry-btn" onclick={() => void load()}>{t('blame.retry')}</button>
    </div>
  {:else if blame?.binary}
    <div class="state" data-testid="file-blame-binary">{t('blame.binary')}</div>
  {:else if blame?.tooLarge}
    <div class="state" data-testid="file-blame-large" data-hard-limit={blame.tooLarge.hardLimit ? 'true' : undefined}>
      <strong>{t('blame.large.title')}</strong>
      <p>{t('blame.large.info', { size: formatBytes(blame.tooLarge.bytes), lines: blame.tooLarge.lines.toLocaleString('en-US') })}</p>
      {#if blame.tooLarge.hardLimit}
        <p class="muted">{t('blame.large.hard')}</p>
      {:else}
        <button type="button" class="btn" data-testid="file-blame-load-btn" disabled={forcing} onclick={() => void load(true)}>
          {forcing ? t('blame.large.loading') : t('blame.large.load')}
        </button>
      {/if}
    </div>
  {:else if blame && rows.length === 0}
    <div class="state muted" data-testid="file-blame-empty">{t('blame.empty')}</div>
  {:else if blame}
    <span class="sr-only" role="status" data-testid="file-blame-status">{announcement}</span>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      bind:this={scroller}
      use:measureHeight={(h) => (viewport = h)}
      class="scroller"
      role="region"
      tabindex="0"
      data-zone-focus
      aria-label={t('blame.region', { path })}
      data-row-count={rows.length}
      {onkeydown}
      onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)}
    >
      <div class="sizer" style:height="{rows.length * BLAME_LINE_HEIGHT}px">
        <div class="window" style:transform={win.first ? `translateY(${win.first * BLAME_LINE_HEIGHT}px)` : undefined}>
          {#each visible as row (row.line)}
            {@const commit = row.hunk >= 0 ? blame.commits[blame.hunks[row.hunk]!.commit] : undefined}
            <div
              class="line"
              class:cursor={cursor === row.line}
              data-testid="file-blame-line"
              data-line={row.line}
              data-commit={commit?.oid}
              data-band={row.hunk >= 0 ? row.hunk % 2 : undefined}
              data-first={row.first ? 'true' : undefined}
            >
              <span class="note">
                {#if row.first && commit}
                  {@const a = annotation(commit, now)}
                  <button
                    type="button"
                    class="pick"
                    tabindex="-1"
                    data-testid="file-blame-annotation"
                    data-commit={commit.oid}
                    data-line={row.line}
                    title={annotationTitle(commit)}
                    onclick={() => pick(row.line)}
                  >
                    <code class="sha">{a.sha}</code>
                    <span class="who truncate">{a.author}</span>
                    <span class="when muted">{a.when}</span>
                  </button>
                {/if}
              </span>
              <span class="no">{row.line}</span>
              <span class="text" data-testid="file-blame-text">{row.text}</span>
            </div>
          {/each}
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .blame {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    min-height: 0;
    background: var(--bg);
  }
  .state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 24px 16px;
    text-align: center;
  }
  .state p {
    margin: 0;
  }
  .scroller {
    flex: 1 1 0;
    min-height: 0;
    overflow: auto;
    font: 12px/20px var(--font-mono);
    tab-size: 4;
  }
  .scroller:focus-visible {
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .sizer {
    position: relative;
    width: max-content;
    min-width: 100%;
  }
  .window {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    will-change: transform;
  }
  .line {
    display: flex;
    height: 20px;
    white-space: pre;
  }
  .line[data-band='1'] {
    background: var(--bg-elev);
  }
  .line[data-first='true'] {
    box-shadow: inset 0 1px 0 var(--border);
  }
  .line.cursor {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }
  .note {
    flex: none;
    position: sticky;
    left: 0;
    z-index: 1;
    display: flex;
    width: 250px;
    background: inherit;
    border-right: 1px solid var(--border);
    font: 11px/20px var(--font-ui);
  }
  .line:not([data-band]) .note,
  .line[data-band='0'] .note {
    background: var(--bg);
  }
  .line[data-band='1'] .note {
    background: var(--bg-elev);
  }
  .pick {
    display: grid;
    grid-template-columns: 56px minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 20px;
    padding: 0 8px;
    border: 0;
    background: transparent;
    color: var(--fg);
    text-align: left;
    font: inherit;
  }
  .pick:hover {
    background: var(--row-hover);
  }
  .sha {
    font: 11px var(--font-mono);
    color: var(--accent);
  }
  .when {
    font-size: 11px;
    white-space: nowrap;
  }
  .no {
    flex: none;
    width: 48px;
    padding-right: 8px;
    text-align: right;
    color: var(--fg-muted);
    user-select: none;
  }
  .text {
    padding-right: 16px;
  }
</style>
