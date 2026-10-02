<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { ui } = captureStores();
  // Bandeaux d'astuce non bloquants (03) : `layout-hint-banner[data-hint=commit-graph|watcher-degraded]`,
  // `layout-hint-dismiss-btn` (masked until the closure of the repository, nothing is persisted).

  import { t } from '$i18n/index';
  import Icon from '../ui/Icon.svelte';
</script>

{#each ui.activeHints as hint (hint)}
  <div class="hint" data-testid="layout-hint-banner" data-hint={hint} role="note">
    <Icon name="info" size={16} />
    <span class="text">{t(`layout.hint.${hint}`)}</span>
    <button type="button" class="icon-btn" data-testid="layout-hint-dismiss-btn" aria-label={t('layout.hint.dismiss')} title={t('layout.hint.dismiss')} onclick={() => ui.dismissHint(hint)}>
      <Icon name="x" size={14} />
    </button>
  </div>
{/each}

<style>
  .hint {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px 4px 12px;
    background: var(--bg-sunken);
    border-bottom: 1px solid var(--border);
    color: var(--fg-muted);
  }
  .text {
    flex: 1;
    min-width: 0;
  }
</style>
