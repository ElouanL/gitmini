<script lang="ts">
  // Command palette (03): `palette`, `palette-input`, `palette-list`, `palette-item[data-command-id]`.
  // Commands by default; `@` branches and tags, `#` commits, `/` repositories (open tabs, then recent ones).
  // Enter runs or jumps (the graph reveals the commit); Mod+Enter checks out the branch or tag.
  import { onDestroy, tick, untrack } from 'svelte';
  import { checkoutTarget } from '$lib/actions/checkout';
  import { focusZone } from '$lib/actions/focus';
  import { highlight } from '$lib/actions/fuzzy';
  import { availableCommands, parseQuery, pushRecent } from '$lib/actions/palette';
  import {
    commandSections, commitSections, itemsOf, loadedCommits, refSections, repoSections, resultsStatus, toRows,
    type OpenTab, type PaletteItem, type PaletteSection,
  } from '$lib/actions/palette-entities';
  import { runAction } from '$lib/actions/registry';
  import { formatKeys, matchesKeys, shortcutFor } from '$lib/actions/shortcuts';
  import { normalizeRecentCommands } from '$lib/ipc/settings-types';
  import { app } from '$lib/stores/app.svelte';
  import { captureStores } from '$lib/stores/context';
  import { graph } from '$lib/stores/graph.svelte';
  import { op } from '$lib/stores/op.svelte';
  import { refs } from '$lib/stores/refs.svelte';
  import { repo } from '$lib/stores/repo.svelte';
  import { activeSession } from '$lib/stores/session.svelte';
  import { ui } from '$lib/stores/ui.svelte';
  import { t } from '$i18n/index';
  import { CommitLookup, LOOKUP_LIMIT } from './commit-lookup.svelte';

  let query = $state('');
  let active = $state(0);
  let input = $state<HTMLInputElement | null>(null);
  let previousFocus: HTMLElement | null = null;
  const lookup = new CommitLookup();
  onDestroy(() => lookup.clear());

  const parsed = $derived(parseQuery(query));
  const hasRepo = $derived(repo.isOpen);
  const recent = $derived(normalizeRecentCommands(app.get('palette.recent')));
  const openTabs = $derived<OpenTab[]>(repo.tabs.flatMap((session) => (session.info ? [{ session, name: session.info.name, path: session.info.workdir }] : [])));
  /** `#` with text: the search is out and has not answered for what is typed yet. */
  const lookingUp = $derived(parsed.mode === 'commits' && parsed.term !== '' && hasRepo && (lookup.searching || lookup.answered !== parsed.term));

  const sections = $derived.by<PaletteSection[]>(() => {
    if (!ui.paletteOpen) return [];
    switch (parsed.mode) {
      case 'commands':
        return commandSections(availableCommands(), parsed.term, recent);
      case 'refs':
        return hasRepo ? refSections(refs.snapshot, parsed.term, op.blockReason('write') === null) : [];
      case 'commits':
        if (!hasRepo) return [];
        return parsed.term ? commitSections(lookup.found, lookup.answered) : commitSections(loadedCommits(graph.sortedPages), '');
      case 'repos':
        return repoSections(openTabs, activeSession.current, repo.recents, parsed.term);
    }
  });
  const rows = $derived(toRows(sections));
  const items = $derived(itemsOf(sections));
  const activeItem = $derived(items[active] ?? null);
  const status = $derived(lookingUp ? t('palette.searching') : resultsStatus(items.length));
  const emptyText = $derived.by(() => {
    switch (parsed.mode) {
      case 'commands': return t('palette.empty');
      case 'refs': return hasRepo ? t('palette.empty.refs') : t('palette.noRepo.refs');
      case 'commits': return !hasRepo ? t('palette.noRepo.commits') : lookingUp ? t('palette.searching') : t('palette.empty.commits');
      case 'repos': return t('palette.empty.repos');
    }
  });
  const hint = $derived.by(() => {
    switch (parsed.mode) {
      case 'commands': return t('palette.hint.commands');
      case 'refs': return activeItem?.kind === 'ref' && activeItem.checkout ? t('palette.hint.refsCheckout', { keys: formatKeys('Mod+Enter') }) : t('palette.hint.refs');
      case 'commits': return t('palette.hint.commits');
      case 'repos': return t('palette.hint.repos');
    }
  });

  $effect(() => {
    if (ui.paletteOpen) {
      previousFocus = document.activeElement as HTMLElement | null;
      query = '';
      active = 0;
      void tick().then(() => input?.focus());
    }
  });

  $effect(() => {
    // `#` with text searches the whole history (after a pause in typing); anything else, or closing, drops the results.
    const term = ui.paletteOpen && parsed.mode === 'commits' && hasRepo ? parsed.term : '';
    untrack(() => lookup.search(term));
  });

  $effect(() => {
    // The selection remains in the list when the filter shortens it.
    if (active >= items.length) active = Math.max(0, items.length - 1);
  });

  function close(restore = true): void {
    ui.paletteOpen = false;
    if (restore && previousFocus?.isConnected) previousFocus.focus();
  }

  /** Select the commit and show it in the graph, which then takes the keyboard (arrows walk from there). */
  async function goTo(oid: string): Promise<void> {
    const scope = captureStores();
    try {
      scope.ui.closeCenter();
      await scope.graph.reveal(oid);
      await tick();
      if (activeSession.current === scope.session) focusZone('graph');
    } catch (e) {
      scope.reportError(e);
    }
  }

  function switchTo(session: OpenTab['session']): void {
    if (!repo.activate(session)) return;
    void tick().then(() => document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true }));
  }

  function execute(item: PaletteItem | null, checkout = false): void {
    if (!item) return;
    if (checkout) {
      // Only a branch or tag can be checked out; when it cannot (current branch, a write in flight) nothing happens.
      if (item.kind !== 'ref' || !item.checkout) return;
      close(false);
      void checkoutTarget(item.checkout);
      return;
    }
    close(false);
    switch (item.kind) {
      case 'command':
        void app.set('palette.recent', pushRecent(recent, item.id));
        void runAction(item.id);
        break;
      case 'ref':
      case 'commit':
        void goTo(item.oid);
        break;
      case 'repo':
        if (item.tab) switchTo(item.tab);
        else void repo.open(item.path);
        break;
    }
  }

  function onkeydown(e: KeyboardEvent): void {
    if (e.isComposing) return;
    const n = items.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (n) active = (active + 1) % n;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (n) active = (active - 1 + n) % n;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // While the search for the text typed is out, the list still holds the answer for the previous text: no pick yet.
      if (lookingUp) return;
      execute(activeItem, e.metaKey || e.ctrlKey);
    } else if (e.key === 'Home') {
      e.preventDefault();
      active = 0;
    } else if (e.key === 'End') {
      e.preventDefault();
      active = Math.max(0, n - 1);
    } else if (e.key === 'Escape' || matchesKeys(e, shortcutFor('palette.open') ?? 'Mod+K')) {
      // Closed here (not by the global handler) so that the focus goes back to where it was.
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      // Focus trapped: the input field is the only focal element of the palette (results are chosen at the arrows).
      e.preventDefault();
    }
  }

  $effect(() => {
    // Scroll the active entry in the list.
    void activeItem;
    void tick().then(() => document.querySelector('[data-testid="palette-item"][aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }));
  });
</script>

{#if ui.paletteOpen}
  <div
    class="overlay"
    role="presentation"
    onpointerdown={(e) => {
      if (e.target === e.currentTarget) close();
    }}
  >
    <div class="palette" data-testid="palette" data-mode={parsed.mode} role="dialog" aria-modal="true" aria-label={t('palette.label')}>
      <input
        bind:this={input}
        bind:value={query}
        class="search"
        data-testid="palette-input"
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant={activeItem ? `palette-opt-${active}` : undefined}
        placeholder={t('palette.placeholder')}
        autocomplete="off"
        spellcheck="false"
        oninput={() => (active = 0)}
        {onkeydown}
      />
      <ul id="palette-list" data-testid="palette-list" role="listbox" aria-label={t('palette.label')} aria-busy={lookingUp}>
        {#each rows as row (row.key)}
          {#if row.type === 'header'}
            <li class="group" role="presentation" data-testid="palette-section">{row.label}</li>
          {:else}
            {@const item = row.item}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <li
              id="palette-opt-{row.index}"
              role="option"
              aria-selected={row.index === active}
              data-testid="palette-item"
              data-kind={item.kind}
              data-label={item.label}
              title={item.title ?? undefined}
              data-command-id={item.kind === 'command' ? item.id : undefined}
              data-oid={item.kind === 'ref' || item.kind === 'commit' ? item.oid : undefined}
              data-ref-kind={item.kind === 'ref' ? item.refKind : undefined}
              data-path={item.kind === 'repo' ? item.path : undefined}
              data-current={item.current ? 'true' : undefined}
              class:active={row.index === active}
              onpointermove={() => (active = row.index)}
              onmousedown={(e) => e.preventDefault()}
              onclick={() => execute(item)}
            >
              <span class="label">
                {#each highlight(item.label, item.match) as part, i (i)}{#if part.match}<mark data-testid="palette-match">{part.text}</mark>{:else}{part.text}{/if}{/each}
              </span>
              {#if item.detail}<span class="detail muted" class:mono={item.kind === 'commit'}>{item.detail}</span>{/if}
              {#if item.badge}<span class="badge" class:current={item.current} data-testid="palette-item-badge">{item.badge}</span>{/if}
              {#if item.kind === 'command'}
                {@const keys = shortcutFor(item.id)}
                {#if keys}<kbd>{formatKeys(keys)}</kbd>{/if}
              {/if}
            </li>
          {/if}
        {:else}
          <li class="empty" role="presentation" data-testid="palette-empty">{emptyText}</li>
        {/each}
        {#if parsed.mode === 'commits' && parsed.term && lookup.truncated && !lookingUp}
          <li class="empty" role="presentation" data-testid="palette-truncated">{t('palette.truncated', { n: LOOKUP_LIMIT })}</li>
        {/if}
      </ul>
      <div class="hint muted" data-testid="palette-hint">{hint}</div>
      <div class="sr-only" role="status" data-testid="palette-status">{status}</div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: var(--z-menu);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 14vh;
    background: var(--overlay);
  }
  .palette {
    width: min(560px, calc(100vw - 32px));
    max-height: 60vh;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    overflow: hidden;
  }
  .search {
    flex: none;
    width: 100%;
    height: 44px;
    padding: 0 16px;
    border: 0;
    border-bottom: 1px solid var(--border);
    background: transparent;
    color: var(--fg);
    font-size: 15px;
  }
  .search:focus-visible {
    box-shadow: none;
  }
  ul {
    flex: 1;
    overflow: auto;
    padding: 4px;
  }
  li {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 32px;
    padding: 0 12px;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  li.active {
    background: var(--row-selected);
  }
  li.empty {
    height: auto;
    min-height: 32px;
    color: var(--fg-muted);
    cursor: default;
  }
  li.group {
    height: 24px;
    margin-top: 4px;
    padding: 0 12px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--fg-muted);
    cursor: default;
  }
  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .detail {
    flex: 0 1 auto;
    max-width: 45%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
  }
  .badge {
    flex: none;
    padding: 0 6px;
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 11px;
    line-height: 16px;
    color: var(--fg-muted);
    white-space: nowrap;
  }
  .badge.current {
    border-color: var(--accent);
    color: var(--accent);
  }
  mark {
    background: transparent;
    color: var(--accent);
    font-weight: 700;
  }
  .hint {
    flex: none;
    padding: 6px 12px;
    border-top: 1px solid var(--border);
    font-size: 11px;
  }
</style>
