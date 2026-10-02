<script lang="ts">
  // Palette de commandes simple (03) : `palette`, `palette-input`, `palette-list`, `palette-item[data-command-id]`.
  import { tick } from 'svelte';
  import { availableCommands, filterCommands } from '$lib/actions/palette';
  import { runAction } from '$lib/actions/registry';
  import { formatKeys, shortcutFor } from '$lib/actions/shortcuts';
  import { ui } from '$lib/stores/ui.svelte';
  import { t } from '$i18n/index';

  let query = $state('');
  let active = $state(0);
  let input = $state<HTMLInputElement | null>(null);
  let previousFocus: HTMLElement | null = null;

  const results = $derived(ui.paletteOpen ? filterCommands(availableCommands(), query) : []);
  const activeId = $derived(results[active]?.id ?? null);

  $effect(() => {
    if (ui.paletteOpen) {
      previousFocus = document.activeElement as HTMLElement | null;
      query = '';
      active = 0;
      void tick().then(() => input?.focus());
    }
  });

  $effect(() => {
    // The selection remains in the list when the filter shortens it.
    if (active >= results.length) active = Math.max(0, results.length - 1);
  });

  function close(restore = true): void {
    ui.paletteOpen = false;
    if (restore && previousFocus?.isConnected) previousFocus.focus();
  }

  function execute(id: string | null): void {
    if (!id) return;
    close(false);
    void runAction(id);
  }

  function onkeydown(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (results.length) active = (active + 1) % results.length;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length) active = (active - 1 + results.length) % results.length;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      execute(activeId);
    } else if (e.key === 'Home') {
      e.preventDefault();
      active = 0;
    } else if (e.key === 'End') {
      e.preventDefault();
      active = Math.max(0, results.length - 1);
    } else if (e.key === 'Tab') {
      // Focus trapped: the input field is the only focal element of the palette (results are chosen at the arrows).
      e.preventDefault();
    }
  }

  $effect(() => {
    // Scroll the active entry in the list.
    void activeId;
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
    <div class="palette" data-testid="palette" role="dialog" aria-modal="true" aria-label={t('palette.label')}>
      <input
        bind:this={input}
        bind:value={query}
        class="search"
        data-testid="palette-input"
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant={activeId ? `palette-opt-${activeId}` : undefined}
        placeholder={t('palette.placeholder')}
        autocomplete="off"
        spellcheck="false"
        {onkeydown}
      />
      <ul id="palette-list" data-testid="palette-list" role="listbox" aria-label={t('palette.label')}>
        {#each results as r, i (r.id)}
          {@const keys = shortcutFor(r.id)}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <li
            id="palette-opt-{r.id}"
            role="option"
            aria-selected={i === active}
            data-testid="palette-item"
            data-command-id={r.id}
            class:active={i === active}
            onpointermove={() => (active = i)}
            onclick={() => execute(r.id)}
          >
            <span class="label">{r.label}</span>
            {#if keys}<kbd>{formatKeys(keys)}</kbd>{/if}
          </li>
        {:else}
          <li class="empty" role="presentation">{t('palette.empty')}</li>
        {/each}
      </ul>
      <div class="hint muted">{t('palette.hint')}</div>
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
    justify-content: space-between;
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
    color: var(--fg-muted);
    cursor: default;
  }
  .hint {
    padding: 6px 12px;
    border-top: 1px solid var(--border);
    font-size: 11px;
  }
</style>
