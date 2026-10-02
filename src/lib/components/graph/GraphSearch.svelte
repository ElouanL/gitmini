<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { graph } = captureStores();
  // Search bar: `graph-search`, low field 150 ms, counter "3 / 42", previous / next, close.
  // `Enter` = next, `Shift+Enter` = previous; `Escape` closed (global dispatcher) and keeps the selection.
  import { onMount } from 'svelte';

  import { t } from '$i18n/index';
  import Icon from '../ui/Icon.svelte';
  import type { GraphController } from './controller.svelte';

  let { ctrl }: { ctrl: GraphController } = $props();
  const search = $derived(ctrl.search);
  let input: HTMLInputElement;

  onMount(() => {
    input.focus();
    input.select();
    return () => {
      // Closing: ignored flight queries, highlighted removed, focus returned to the graph; current selection is kept.
      if (!graph.searchOpen) graph.searchQuery = '';
      search.close();
      ctrl.els?.viewport.focus({ preventScroll: true });
    };
  });

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) search.prev();
      else search.next();
    }
  }
</script>

<div class="gr-search" data-testid="graph-search" role="search">
  <input
    bind:this={input}
    class="input"
    type="search"
    data-testid="graph-search-input"
    data-empty-result={search.empty ? 'true' : undefined}
    aria-label={t('graph.search.label')}
    placeholder={t('graph.search.placeholder')}
    value={search.query}
    oninput={(e) => { graph.searchQuery = e.currentTarget.value; search.input(e.currentTarget.value); }}
    onkeydown={onKeydown}
    spellcheck="false"
    autocomplete="off"
  />
  <span class="gr-search-count muted" data-testid="graph-search-count" aria-live="polite">{search.label}</span>
  <button type="button" class="icon-btn" data-testid="graph-search-prev-btn" title={t('graph.search.prev')} aria-label={t('graph.search.prev')} disabled={search.matches.length === 0} onclick={() => search.prev()}>
    <span class="gr-flip"><Icon name="chevron-down" size={14} /></span>
  </button>
  <button type="button" class="icon-btn" data-testid="graph-search-next-btn" title={t('graph.search.next')} aria-label={t('graph.search.next')} disabled={search.matches.length === 0} onclick={() => search.next()}>
    <Icon name="chevron-down" size={14} />
  </button>
  <button type="button" class="icon-btn" data-testid="graph-search-close-btn" title={t('graph.search.close')} aria-label={t('graph.search.close')} onclick={() => (graph.searchOpen = false)}>
    <Icon name="x" size={14} />
  </button>
</div>
