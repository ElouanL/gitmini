<script lang="ts">
  // Makes a component saved in a registry, whether it is already loaded or loaded (separate chunk, see lazy.svelte.ts):
  // reserved space carrying `placeholderTestid` if nothing is recorded, waiting indicator (without data-testid) during the
  // loading, error message if the chunk does not load.
  import type { LazyComponent } from '$lib/lazy.svelte';
  import { t } from '$i18n/index';
  import Placeholder from './Placeholder.svelte';
  import Spinner from './Spinner.svelte';

  let { entry, props = {}, placeholderTestid }: { entry: LazyComponent | undefined; props?: Record<string, unknown>; placeholderTestid: string } = $props();

  $effect(() => {
    entry?.ensure();
  });
</script>

{#if !entry}
  <Placeholder testid={placeholderTestid} />
{:else if entry.component}
  {@const View = entry.component}
  <View {...props} />
{:else if entry.status === 'error'}
  <Placeholder testid="{placeholderTestid}-error" message={t('dialog.loadFailed', { id: placeholderTestid })} />
{:else}
  <div class="loading" role="status" aria-busy="true" aria-label={t('panel.loading')}><Spinner /></div>
{/if}

<style>
  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    min-height: 48px;
  }
</style>
