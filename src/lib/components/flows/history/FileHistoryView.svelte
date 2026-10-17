<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { graph, reportError, session, ui } = captureStores();
  // `file-history`: central view listing the commits that changed one file, newest first, with what the selected one changed
  // (the diff viewer, embedded) or the file at that commit annotated line by line (the blame view). Opened from a diff, a file
  // menu or the palette: `ui.openCenter('file-history', { path, rev?, mode? })`.
  // The list is paged by the backend (`file_log`): "Load more" goes further back, and a page that found nothing yet (the backend
  // looks at a bounded stretch of history per call) is followed by the next one without asking. Follows renames by default.
  import { onMount, tick, untrack } from 'svelte';
  import { roving } from '$lib/actions/roving';
  import { commands } from '$lib/ipc/commands';
  import { onEvent } from '$lib/ipc/events';
  import type { AppError, ChangeKind, DiffSource, FileLogEntry } from '$lib/ipc/types';
  import DiffViewer from '../../diff/DiffViewer.svelte';
  import { createCoalescer } from '$lib/stores/schedule';
  import { formatRelative, shortOid } from '$lib/format';
  import { t } from '$i18n/index';
  import Icon from '$lib/components/ui/Icon.svelte';
  import Spinner from '$lib/components/ui/Spinner.svelte';
  import BlameView from './BlameView.svelte';
  import { appendEntries, CHANGE_LETTER, countText, entryDate, entryParent, entryStat, MAX_FILL_PAGES, nameNote } from './history-logic';
  import type { HistoryMode } from './open';

  interface Props {
    path: string;
    rev?: string | null;
    mode?: HistoryMode;
  }

  /** The commit whose changes (or blame) the right side shows; it need not be in the list (a blame pick can lead anywhere). */
  interface Selection {
    oid: string;
    path: string;
    parent: number | null;
    change: ChangeKind;
  }

  let { path, rev = null, mode: modeProp = 'changes' }: Props = $props();

  // The props only give the start; the user can change it afterwards ("From HEAD"), the props win again when they change.
  let rootRev = $state<string | null>(untrack(() => rev));
  let follow = $state(true);
  let mode = $state<HistoryMode>(untrack(() => modeProp));
  let entries = $state.raw<FileLogEntry[]>([]);
  let cursor = $state<string | null>(null);
  /** The first page is on its way. */
  let loading = $state(true);
  /** Further pages are on their way. */
  let searching = $state(false);
  let loadError = $state.raw<AppError | null>(null);
  let selected = $state.raw<Selection | null>(null);
  let list = $state<HTMLElement>();
  let seq = 0;

  const selectedEntry = $derived(selected ? (entries.find((e) => e.oid === selected!.oid) ?? null) : null);
  const source = $derived<DiffSource | null>(selected ? { kind: 'commit', oid: selected.oid, parent: selected.parent } : null);
  /** The version of the file just before the selected commit deleted it: the entry below in the list. */
  const previous = $derived.by(() => {
    if (!selected) return null;
    const at = entries.findIndex((e) => e.oid === selected!.oid);
    return at >= 0 ? (entries[at + 1] ?? null) : null;
  });
  const deletedHere = $derived(selected?.change === 'deleted');

  /** Selects `next`; the very same selection keeps its object, so the diff on screen is not read again. */
  function select(next: Selection): void {
    const cur = selected;
    if (cur && cur.oid === next.oid && cur.path === next.path && cur.parent === next.parent && cur.change === next.change) return;
    selected = next;
  }

  function selectEntry(e: FileLogEntry): void {
    select({ oid: e.oid, path: e.file.path, parent: entryParent(e), change: e.file.change });
  }

  /**
   * Reads pages until `wanted` entries came in or the history is exhausted. `reset` starts over from the top. A bounded page can
   * hold nothing and still have a cursor; going on is cheap for the user (a spinner) and keeps "Load more" meaningful.
   */
  async function fetchPages(reset: boolean, wanted: number): Promise<void> {
    const repoId = session.repoId;
    if (repoId === null) return;
    const gen = session.gen;
    const mine = ++seq;
    const keep = reset ? selected?.oid ?? null : null;
    loadError = null;
    if (reset) loading = entries.length === 0;
    searching = !reset;
    let next: string | null = reset ? null : cursor;
    let found = 0;
    let all: FileLogEntry[] = reset ? [] : entries;
    let settled = !reset;
    try {
      for (let guard = 0; guard < MAX_FILL_PAGES; guard++) {
        const page = await commands.fileLog({
          repoId, path, follow,
          ...(rootRev !== null ? { rev: rootRev } : {}),
          ...(next !== null ? { cursor: next } : {}),
        });
        if (mine !== seq || !session.isCurrent(gen)) return;
        all = appendEntries(all, page.entries);
        found += page.entries.length;
        next = page.nextCursor;
        entries = all;
        cursor = next;
        loading = false;
        // The first page that has a commit decides the selection (an empty one is followed by the next, see above).
        if (!settled && all.length > 0) {
          settleSelection(keep);
          settled = true;
        }
        if (next === null || found >= wanted) break;
        searching = true;
      }
      if (!settled) settleSelection(keep);
    } catch (e) {
      if (mine !== seq) return;
      loadError = reportError(e, { command: 'file_log', quiet: true });
    } finally {
      if (mine === seq) {
        loading = false;
        searching = false;
      }
    }
  }

  /** After a (re)load: keep the commit that was selected if it is still listed, else the newest one. */
  function settleSelection(keep: string | null): void {
    const first = entries[0];
    const kept = keep !== null ? entries.find((e) => e.oid === keep) : undefined;
    const pick = kept ?? first;
    if (pick) selectEntry(pick);
    else selected = null;
  }

  // `ui.openCenter` again on the open view (another file, another start, the blame tab): follow the new props.
  let seenProps = untrack(() => ({ path, rev, mode: modeProp }));
  $effect(() => {
    const p = { path, rev, mode: modeProp };
    if (p.path === seenProps.path && p.rev === seenProps.rev && p.mode === seenProps.mode) return;
    const startChanged = p.path !== seenProps.path || p.rev !== seenProps.rev;
    seenProps = p;
    untrack(() => {
      mode = p.mode;
      if (startChanged) rootRev = p.rev ?? null;
    });
  });

  // A new file, start or `follow`: the list starts over (the selected commit is kept when it is still listed).
  let lastKey = '';
  $effect(() => {
    const key = `${path}\u0000${rootRev ?? ''}\u0000${follow}`;
    if (key === lastKey) return;
    const sameFile = lastKey !== '' && lastKey.split('\u0000')[0] === path;
    lastKey = key;
    untrack(() => {
      entries = [];
      cursor = null;
      loading = true;
      if (!sameFile) selected = null;
      void fetchPages(true, 1);
    });
  });

  // A new commit or a moved ref changes a history that starts at HEAD.
  const refresher = createCoalescer(() => fetchPages(true, 1));
  onMount(() =>
    onEvent('repo:changed', (ev) => {
      if (ev.repoId === session.repoId && rootRev === null && (ev.kinds.includes('head') || ev.kinds.includes('refs'))) void refresher.trigger();
    }),
  );

  // The selected commit stays visible in the list when it changes by other means than a click on it (blame pick, reload).
  $effect(() => {
    const oid = selected?.oid;
    if (!oid) return;
    void tick().then(() => {
      list?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
    });
  });

  function pickFromBlame(oid: string, blamedPath: string): void {
    const known = entries.find((e) => e.oid === oid);
    if (known) selectEntry(known);
    else select({ oid, path: blamedPath, parent: null, change: 'modified' });
    mode = 'changes';
  }

  function blamePrevious(): void {
    if (previous) selectEntry(previous);
  }

  function reveal(e: FileLogEntry): void {
    ui.closeCenter();
    void graph.reveal(e.oid);
  }

  function resetToHead(): void {
    rootRev = null;
  }

  /** ArrowRight on a commit goes to its graph button (kept out of the tab order: a list of 100 commits is one tab stop), ArrowLeft back. */
  function sideKeydown(e: KeyboardEvent, to: 'reveal' | 'main'): void {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== (to === 'reveal' ? 'ArrowRight' : 'ArrowLeft')) return;
    const row = (e.currentTarget as HTMLElement).closest('li');
    const target = row?.querySelector<HTMLElement>(to === 'reveal' ? '[data-testid="file-history-item-reveal-btn"]' : '[data-roving]');
    if (!target) return;
    e.preventDefault();
    target.focus();
  }

  const TABS: { id: HistoryMode; label: string }[] = [
    { id: 'changes', label: 'history.tab.changes' },
    { id: 'blame', label: 'history.tab.blame' },
  ];

  let tabs = $state<HTMLElement>();
  function tabKeydown(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const at = TABS.findIndex((tab) => tab.id === mode);
    let next = -1;
    if (e.key === 'ArrowRight') next = (at + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (at - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    mode = TABS[next]!.id;
    void tick().then(() => tabs?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
  }

  const more = $derived(cursor !== null);
  const baseName = $derived(path.slice(path.lastIndexOf('/') + 1));
</script>

<section
  class="history"
  data-testid="file-history-view"
  data-path={path}
  data-rev={rootRev ?? undefined}
  data-follow={follow ? 'true' : 'false'}
  data-mode={mode}
  aria-label={t('history.view', { path })}
>
  <header class="head">
    <span class="chip muted">{t('history.chip')}</span>
    <span class="path" title={path}><strong>{path}</strong></span>
    {#if rootRev !== null}
      <span class="chip muted" data-testid="file-history-rev" title={rootRev}>{t('history.from', { rev: shortOid(rootRev) })}</span>
      <button type="button" class="hbtn" data-testid="file-history-head-btn" title={t('history.fromHead.title')} onclick={resetToHead}>{t('history.fromHead')}</button>
    {/if}
    <span class="spacer"></span>
    <label class="follow" title={t('history.follow.title')}>
      <input type="checkbox" data-testid="file-history-follow-toggle" bind:checked={follow} />
      <span>{t('history.follow')}</span>
    </label>
    <button type="button" class="icon-btn" data-testid="file-history-close-btn" title={t('history.close')} aria-label={t('history.close')} onclick={() => ui.closeCenter()}>
      <Icon name="x" size={14} />
    </button>
  </header>

  <div class="body">
    <div class="side">
      <div class="count muted" role="status" data-testid="file-history-count" data-more={more ? 'true' : undefined}>
        {#if loading}{t('history.loading')}{:else if !(loadError && entries.length === 0)}{countText(entries.length, more)}{/if}
      </div>

      {#if loading}
        <p class="state muted" data-testid="file-history-loading"><Spinner size={12} /> {t('history.loading')}</p>
      {:else if loadError && entries.length === 0}
        <div class="state" data-testid="file-history-error" role="alert">
          <p>{t('history.error')}</p>
          <p class="muted">{loadError.message}</p>
          <button type="button" class="btn" data-testid="file-history-retry-btn" onclick={() => void fetchPages(true, 1)}>{t('history.retry')}</button>
        </div>
      {:else if entries.length === 0 && !searching}
        <div class="state" data-testid="file-history-empty">
          <p>{t('history.empty')}</p>
          <p class="muted">{t('history.emptyHint')}</p>
        </div>
      {:else}
        <ul class="list" bind:this={list} use:roving={'[data-roving]'} aria-label={t('history.list.label', { path })} data-testid="file-history-list">
          {#each entries as e (e.oid)}
            {@const stat = entryStat(e)}
            {@const note = nameNote(e, path)}
            {@const isSelected = selected?.oid === e.oid}
            <li class="row" class:selected={isSelected} data-testid="file-history-item" data-oid={e.oid} data-path={e.file.path} data-change={e.file.change} data-selected={isSelected ? 'true' : undefined}>
              <button type="button" class="main" data-roving aria-current={isSelected ? 'true' : undefined} title={`${e.summary}\n${entryDate(e)}`} onclick={() => selectEntry(e)} onkeydown={(ev) => sideKeydown(ev, 'reveal')}>
                <span class="letter" data-change={e.file.change} title={t(`graph.change.${e.file.change}`)}>{CHANGE_LETTER[e.file.change]}</span>
                <span class="summary truncate">{e.summary}</span>
                <span class="meta muted truncate">
                  <code class="sha">{shortOid(e.oid)}</code>
                  <span>{e.author.name}</span>
                  <span>{formatRelative(e.author.time)}</span>
                  {#if e.parents.length > 1}
                    <span class="merge" data-testid="file-history-item-merge" title={t('history.item.merge.title', { n: e.parent ?? 1 })}>{t('history.item.merge')}</span>
                  {/if}
                </span>
                <span class="stat">
                  {#if stat === 'binary'}
                    <span class="muted">{t('history.item.binary')}</span>
                  {:else if stat}
                    <span class="add">+{stat.add}</span> <span class="del">−{stat.del}</span>
                  {/if}
                </span>
                {#if note}<span class="note muted truncate" data-testid="file-history-item-note">{note}</span>{/if}
              </button>
              <button
                type="button"
                class="icon-btn"
                data-testid="file-history-item-reveal-btn"
                tabindex="-1"
                title={t('history.item.reveal')}
                aria-label={t('history.item.revealAria', { sha: shortOid(e.oid) })}
                onclick={() => reveal(e)}
                onkeydown={(ev) => sideKeydown(ev, 'main')}
              >
                <Icon name="commit" size={14} />
              </button>
            </li>
          {/each}
        </ul>
        <div class="foot">
          {#if searching}
            <p class="muted" data-testid="file-history-searching"><Spinner size={12} /> {t('history.searching')}</p>
          {:else if more}
            <button type="button" class="btn" data-testid="file-history-more-btn" title={t('history.more.title')} onclick={() => void fetchPages(false, 1)}>{t('history.more')}</button>
          {/if}
          {#if loadError && entries.length > 0}
            <p class="muted" role="alert" data-testid="file-history-more-error">{loadError.message}</p>
          {/if}
        </div>
      {/if}
    </div>

    <div class="content">
      <div class="tabs" role="tablist" aria-label={t('history.tabs.label')} tabindex="-1" bind:this={tabs} onkeydown={tabKeydown}>
        {#each TABS as tab (tab.id)}
          <button
            type="button"
            role="tab"
            class="tab"
            id="file-history-tab-{tab.id}"
            aria-selected={mode === tab.id}
            aria-controls="file-history-pane"
            tabindex={mode === tab.id ? 0 : -1}
            data-testid="file-history-tab-{tab.id}"
            onclick={() => (mode = tab.id)}
          >{t(tab.label)}</button>
        {/each}
        {#if selected}
          <span class="at muted" data-testid="file-history-selected" data-oid={selected.oid}>{t('blame.at', { rev: shortOid(selected.oid) })}</span>
        {/if}
      </div>

      <div class="pane" id="file-history-pane" role="tabpanel" aria-labelledby="file-history-tab-{mode}" data-testid="file-history-pane" data-mode={mode}>
        {#if !selected || !source}
          <div class="state muted" data-testid="file-history-select">{loading ? t('history.loading') : entries.length === 0 ? t('history.empty') : t('history.select')}</div>
        {:else if mode === 'changes'}
          <DiffViewer path={selected.path} {source} embedded />
        {:else if deletedHere}
          <div class="state" data-testid="file-blame-deleted">
            <p>{t('blame.deleted')}</p>
            {#if previous}
              <button type="button" class="btn" data-testid="file-blame-prev-btn" onclick={blamePrevious}>{t('blame.deleted.previous')}</button>
            {/if}
          </div>
        {:else}
          <BlameView path={selected.path} rev={selected.oid} onpick={pickFromBlame} />
        {/if}
      </div>
    </div>
  </div>
  <span class="sr-only" role="status" data-testid="file-history-status">{selectedEntry ? `${baseName}: ${selectedEntry.summary}` : ''}</span>
</section>

<style>
  .history {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    background: var(--bg);
  }
  .head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 38px;
    padding: 0 8px 0 12px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-elev);
  }
  .chip {
    flex: none;
    padding: 0 6px;
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 11px;
    line-height: 18px;
  }
  .path {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .spacer {
    flex: 1;
  }
  .follow {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
  }
  .hbtn {
    flex: none;
    height: 24px;
    padding: 0 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    font-size: 12px;
  }
  .hbtn:hover {
    background: var(--row-hover);
  }
  .body {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(240px, 340px) minmax(0, 1fr);
  }
  .side {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--border);
  }
  .count {
    flex: none;
    padding: 6px 12px;
    font-size: 12px;
    min-height: 28px;
  }
  .state {
    padding: 12px;
    margin: 0;
  }
  .state p {
    margin: 0 0 6px;
  }
  .list {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding: 0;
    list-style: none;
    overflow: auto;
  }
  .row {
    display: flex;
    align-items: stretch;
    gap: 2px;
    padding-right: 4px;
  }
  .row:hover {
    background: var(--row-hover);
  }
  .row.selected {
    background: var(--row-selected);
  }
  .main {
    flex: 1;
    min-width: 0;
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr) auto;
    grid-template-areas: 'letter summary stat' '. meta meta' '. note note';
    column-gap: 8px;
    align-items: center;
    padding: 5px 8px;
    border: 0;
    background: transparent;
    color: var(--fg);
    text-align: left;
    font-size: 13px;
  }
  .main:focus-visible {
    box-shadow: inset 0 0 0 2px var(--accent);
  }
  .row > .icon-btn {
    align-self: center;
  }
  .letter {
    grid-area: letter;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 700;
    color: var(--bg);
    background: var(--fg-muted);
  }
  .letter[data-change='added'] {
    background: var(--success);
  }
  .letter[data-change='modified'],
  .letter[data-change='typechange'] {
    background: var(--warn);
  }
  .letter[data-change='deleted'] {
    background: var(--danger);
  }
  .letter[data-change='renamed'],
  .letter[data-change='copied'] {
    background: var(--info);
  }
  .summary {
    grid-area: summary;
    min-width: 0;
  }
  .meta {
    grid-area: meta;
    display: flex;
    gap: 8px;
    font-size: 12px;
  }
  .note {
    grid-area: note;
    font-size: 12px;
  }
  .sha {
    font-family: var(--font-mono);
    color: var(--accent);
  }
  .merge {
    padding: 0 5px;
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 11px;
  }
  .stat {
    grid-area: stat;
    font: 11px var(--font-mono);
    white-space: nowrap;
  }
  .add {
    color: var(--success);
  }
  .del {
    color: var(--danger);
  }
  .foot {
    flex: none;
    padding: 8px 12px;
  }
  .foot p {
    margin: 0;
    font-size: 12px;
  }
  .content {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .tabs {
    flex: none;
    display: flex;
    align-items: flex-end;
    gap: 2px;
    padding: 4px 8px 0;
    border-bottom: 1px solid var(--border);
  }
  .tab {
    height: 26px;
    padding: 0 12px;
    border: 1px solid transparent;
    border-bottom: 0;
    border-radius: var(--radius-sm) var(--radius-sm) 0 0;
    background: transparent;
    font-size: 12px;
  }
  .tab:hover {
    background: var(--row-hover);
  }
  .tab[aria-selected='true'] {
    border-color: var(--border);
    background: var(--bg-elev);
    font-weight: 600;
    margin-bottom: -1px;
  }
  .at {
    align-self: center;
    margin-left: auto;
    padding-bottom: 4px;
    font: 11px var(--font-mono);
  }
  .pane {
    flex: 1;
    min-height: 0;
    min-width: 0;
  }
  .pane > .state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 24px 16px;
    text-align: center;
  }
</style>
