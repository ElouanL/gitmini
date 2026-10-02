<script lang="ts">
  import { updates } from '$lib/updates/global.svelte';
  import { app } from '$lib/stores/app.svelte';
  import { t } from '$i18n/index';
  const show = $derived(updates.view.installing || (app.get('updates.auto')
    && ['downloading', 'ready'].includes(updates.view.status.phase)));
  const percent = $derived(updates.view.status.total
    ? Math.min(100, Math.round(updates.view.status.downloaded / updates.view.status.total * 100)) : undefined);
</script>

{#if show}
  <div class="update-banner" data-testid="update-banner" data-phase={updates.view.status.phase}>
    <span role="status" aria-live="polite" aria-atomic="true">{updates.message}</span>
    {#if updates.view.status.phase === 'downloading'}
      {#if percent === undefined}
        <progress max="100" aria-label={t('updates.progress')} data-testid="update-progress"></progress>
      {:else}
        <progress max="100" value={percent} aria-label={t('updates.progress')} data-testid="update-progress"></progress>
      {/if}
    {:else if updates.view.status.phase === 'ready' && !updates.view.deferred}
      <button class="btn" type="button" data-testid="update-defer-btn" onclick={() => updates.defer()}>{t('updates.defer')}</button>
    {/if}
  </div>
{/if}

<style>
  .update-banner { display: flex; align-items: center; justify-content: space-between; gap: 16px;
    padding: 8px 16px; background: var(--bg-elev); border-bottom: 1px solid var(--border); font-size: 12px; }
  progress { width: 160px; height: 6px; accent-color: var(--accent); }
</style>
