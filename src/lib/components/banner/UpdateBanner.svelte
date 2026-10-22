<script lang="ts">
  import { updates } from '$lib/updates/global.svelte';
  import { t } from '$i18n/index';
  const phase = $derived(updates.view.status.phase);
  const show = $derived(updates.view.installing || phase === 'downloading'
    || (!updates.view.deferred && updates.canUpdate));
  const percent = $derived(updates.view.status.total
    ? Math.min(100, Math.round(updates.view.status.downloaded / updates.view.status.total * 100)) : undefined);
</script>

{#if show}
  <div class="update-banner" data-testid="update-banner" data-phase={phase}>
    <span role="status" aria-live="polite" aria-atomic="true">{updates.message}</span>
    {#if phase === 'downloading'}
      {#if percent === undefined}
        <progress max="100" aria-label={t('updates.progress')} data-testid="update-progress"></progress>
      {:else}
        <progress max="100" value={percent} aria-label={t('updates.progress')} data-testid="update-progress"></progress>
      {/if}
    {:else if updates.canUpdate}
      <span class="actions">
        <button class="btn btn-primary" type="button" data-testid="update-now-btn" onclick={() => void updates.update()}>
          {phase === 'error' ? t('updates.retry') : t('updates.update')}
        </button>
        <button class="btn" type="button" data-testid="update-defer-btn" onclick={() => updates.defer()}>{t('updates.defer')}</button>
      </span>
    {/if}
  </div>
{/if}

<style>
  .update-banner { display: flex; align-items: center; justify-content: space-between; gap: 16px;
    padding: 8px 16px; background: var(--bg-elev); border-bottom: 1px solid var(--border); font-size: 12px; }
  .actions { display: flex; gap: 8px; flex-shrink: 0; }
  progress { width: 160px; height: 6px; accent-color: var(--accent); }
</style>
