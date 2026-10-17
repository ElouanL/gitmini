<script lang="ts">
  // `reset-dialog`: choice of the reset mode. Resolves the `ResetMode` (confirm) or `undefined` (cancel).
  // `hard` turns the dialog into a destructive one: red button, count of discarded files, initial focus on Cancel.
  import { t, tp } from '$i18n/index';
  import DialogShell from '$lib/components/dialogs-base/DialogShell.svelte';
  import type { DialogProps } from '$lib/dialogs/registry';
  import { shortOid } from '$lib/format';
  import { RESET_MODES, type ResetMode } from './run';

  interface Props extends DialogProps<ResetMode> {
    oid: string;
    branch: string;
    summary?: string | null;
    /** Tracked files with local changes. */
    dirty?: number;
  }

  let { oid, branch, summary = null, dirty = 0, close }: Props = $props();

  let mode = $state<ResetMode>('mixed');
  const hard = $derived(mode === 'hard');
</script>

<DialogShell
  testid="reset-dialog"
  title={t('reset.dialog.title', { branch })}
  danger={hard}
  width={520}
  attrs={{ 'data-mode': mode }}
  onclose={() => close()}
  onsubmit={() => close(mode)}
>
  <p class="target">
    {t('reset.dialog.target', { branch })}
    <span class="sha mono">{shortOid(oid)}</span>
    {#if summary}<span class="truncate summary" title={summary}>{summary}</span>{/if}
  </p>

  <fieldset class="modes">
    <legend class="label">{t('reset.dialog.mode')}</legend>
    {#each RESET_MODES as m (m)}
      <label class="mode" class:selected={mode === m}>
        <input type="radio" name="reset-mode" value={m} data-testid={`reset-mode-${m}`} bind:group={mode} />
        <span>
          <span class="name">{t(`reset.mode.${m}`)}</span>
          <span class="muted desc">{t(`reset.mode.${m}.desc`)}</span>
        </span>
      </label>
    {/each}
  </fieldset>

  {#if hard}
    <p class="warning" role="alert" data-testid="reset-hard-warning">
      {dirty > 0 ? tp('reset.dialog.hardDirty', dirty) : t('reset.dialog.hardClean')}
    </p>
  {/if}

  {#snippet footer()}
    {#key hard}
      <button type="button" class="btn" data-autofocus={hard ? '' : undefined} data-testid="reset-cancel-btn" onclick={() => close()}>
        {t('reset.dialog.cancel')}
      </button>
    {/key}
    <button
      type="button"
      class="btn"
      class:btn-primary={!hard}
      class:btn-danger={hard}
      data-testid="reset-confirm-btn"
      onclick={() => close(mode)}
    >
      {t('reset.dialog.confirm')}
    </button>
  {/snippet}
</DialogShell>

<style>
  .target {
    display: flex;
    gap: 8px;
    align-items: baseline;
    margin: 8px 0 12px;
    min-width: 0;
  }
  .sha {
    flex: none;
    color: var(--fg-muted);
  }
  .summary {
    min-width: 0;
  }
  .modes {
    margin: 0;
    padding: 0;
    border: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .label {
    margin: 0 0 4px;
    padding: 0;
    font-weight: 600;
    font-size: 12px;
    color: var(--fg-muted);
  }
  .mode {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .mode.selected {
    background: var(--bg-elev);
  }
  .name {
    display: block;
    font-weight: 600;
  }
  .desc {
    display: block;
    font-size: 12px;
  }
  .warning {
    margin: 12px 0 0;
    padding: 8px;
    border: 1px solid var(--danger);
    border-radius: var(--radius-sm);
  }
</style>
