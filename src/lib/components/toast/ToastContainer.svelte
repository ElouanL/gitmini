<script lang="ts">
  // `toast-container`, `toast[data-kind]`, `toast-details-btn`, `toast-close-btn`, `toast-undo-btn`, `toast-retry-btn` .
  import { toast } from '$lib/stores/toast.svelte';
  import { t } from '$i18n/index';
  import Icon from '../ui/Icon.svelte';

  let expanded = $state<Record<number, boolean>>({});
</script>

<div class="container" data-testid="toast-container" role="region" aria-label="Notifications" aria-live="polite">
  {#each toast.visible as item (item.id)}
    <div class="toast" data-testid="toast" data-kind={item.kind} role={item.kind === 'error' ? 'alert' : 'status'}>
      <span class="icon" aria-hidden="true">
        <Icon name={item.kind === 'error' ? 'alert' : item.kind === 'success' ? 'check' : item.kind === 'undo' ? 'undo' : 'info'} size={18} />
      </span>
      <div class="content">
        {#if item.title}<div class="title">{item.title}{#if item.count > 1} <span class="count">{t('toast.repeated', { n: item.count })}</span>{/if}</div>{/if}
        <div class="message">{item.message}{#if !item.title && item.count > 1} <span class="count">{t('toast.repeated', { n: item.count })}</span>{/if}</div>
        {#if item.details && expanded[item.id]}
          <div class="details" data-testid="toast-details">
            {#if item.details.stderr}
              <div class="details-label">{t('toast.stderr')}</div>
              <pre data-testid="toast-details-stderr">{item.details.stderr}</pre>
            {/if}
            {#if item.details.args?.length}
              <div class="details-label">{t('toast.args')}</div>
              <pre data-testid="toast-details-args">{item.details.args.join(' ')}</pre>
            {/if}
          </div>
        {/if}
        {#if item.details || item.actions.length}
          <div class="actions">
            {#each item.actions as action (action.testid)}
              <button type="button" class="btn" data-testid={action.testid} onclick={() => void action.run()}>{action.label}</button>
            {/each}
            {#if item.details}
              <button
                type="button"
                class="btn btn-ghost"
                data-testid="toast-details-btn"
                aria-expanded={expanded[item.id] ? 'true' : 'false'}
                onclick={() => (expanded[item.id] = !expanded[item.id])}
              >
                {expanded[item.id] ? t('toast.detailsHide') : t('toast.details')}
              </button>
            {/if}
          </div>
        {/if}
      </div>
      <button type="button" class="icon-btn" data-testid="toast-close-btn" aria-label={t('toast.close')} onclick={() => toast.dismiss(item.id)}>
        <Icon name="x" size={14} />
      </button>
    </div>
  {/each}
</div>

<style>
  .container {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: var(--z-toast);
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: min(420px, calc(100vw - 32px));
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 8px 10px 12px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-left: 4px solid var(--info);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
  }
  .toast[data-kind='error'] {
    border-left-color: var(--danger);
  }
  .toast[data-kind='success'] {
    border-left-color: var(--success);
  }
  .toast[data-kind='undo'] {
    border-left-color: var(--warn);
  }
  .icon {
    margin-top: 1px;
    color: var(--info);
  }
  .toast[data-kind='error'] .icon {
    color: var(--danger);
  }
  .toast[data-kind='success'] .icon {
    color: var(--success);
  }
  .toast[data-kind='undo'] .icon {
    color: var(--warn);
  }
  .content {
    flex: 1;
    min-width: 0;
  }
  .title {
    font-weight: 600;
  }
  .message {
    white-space: pre-line;
    overflow-wrap: anywhere;
  }
  .count {
    color: var(--fg-muted);
    font-size: 11px;
  }
  .actions {
    display: flex;
    gap: 6px;
    margin-top: 8px;
  }
  .details {
    margin-top: 8px;
  }
  .details-label {
    font-size: 11px;
    color: var(--fg-muted);
    margin-top: 4px;
  }
  pre {
    margin: 2px 0 0;
    max-height: 180px;
    overflow: auto;
    padding: 6px 8px;
    background: var(--bg-sunken);
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: 11.5px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
