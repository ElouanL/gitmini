<script lang="ts">
  // `confirm-dialog[data-action][data-danger]`: generic confirmation (03). Resolves `true` / `false` (via `close`).
  import type { DialogProps } from '$lib/dialogs/registry';
  import type { ConfirmActionId } from '$lib/dialogs/confirm';
  import { t } from '$i18n/index';
  import DialogShell from './DialogShell.svelte';

  interface Props extends DialogProps<boolean> {
    action: ConfirmActionId;
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel?: string;
    danger?: boolean;
  }

  let { action, title, message, confirmLabel, cancelLabel, danger = false, close }: Props = $props();
</script>

<DialogShell
  testid="confirm-dialog"
  {title}
  {danger}
  width={460}
  attrs={{ 'data-action': action, 'data-danger': String(danger) }}
  onclose={() => close(false)}
>
  <p class="message">{message}</p>
  {#snippet footer()}
    <!-- Hazard: initial focus on Cancel, `Enter` alone never executes an irreversible action. -->
    <button type="button" class="btn" data-testid="confirm-dialog-cancel-btn" data-autofocus={danger ? '' : undefined} onclick={() => close(false)}>
      {cancelLabel ?? t('confirm.cancel')}
    </button>
    <button
      type="button"
      class="btn {danger ? 'btn-danger' : 'btn-primary'}"
      data-testid="confirm-dialog-confirm-btn"
      data-autofocus={danger ? undefined : ''}
      onclick={() => close(true)}
    >
      {confirmLabel}
    </button>
  {/snippet}
</DialogShell>

<style>
  .message {
    margin: 8px 0 0;
    white-space: pre-line;
  }
</style>
