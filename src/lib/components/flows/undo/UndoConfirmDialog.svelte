<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { undo } = captureStores();
  // `undo-confirm-dialog[data-kind]` (11 §UI): opened by `undo.last` (toolbar-undo-btn, Mod+Z).
  // `undo-cancel-btn`; `undo-confirm-btn` calls `undo_last` (entryId + expectedHead captured at the opening).
  import type { DialogProps } from '$lib/dialogs/registry';
  import type { UndoEntry } from '$lib/ipc/types';

  import { t } from '$i18n/index';
  import DialogShell from '$lib/components/dialogs-base/DialogShell.svelte';
  import { undoDescription } from './undo-text';

  interface Props extends DialogProps<boolean> {
    entry: UndoEntry;
    expectedHead?: string | null;
  }

  let { entry, expectedHead = null, close }: Props = $props();
  let busy = $state(false);

  const description = $derived(undoDescription(entry));

  async function confirm(): Promise<void> {
    if (busy) return;
    busy = true;
    // Errors (DIRTY_WORKTREE, STALE, UNDO_UNAVAILABLE...) are routed by `runWrite`; the dialog closes in all cases.
    const ok = await undo.perform(entry, expectedHead);
    close(ok);
  }
</script>

<DialogShell testid="undo-confirm-dialog" title={t('undo.confirm.title')} attrs={{ 'data-kind': entry.kind }} width={460} onclose={() => close(false)}>
  <p class="description" data-testid="undo-confirm-description">{description}</p>
  {#snippet footer()}
    <button type="button" class="btn" data-testid="undo-cancel-btn" data-autofocus disabled={busy} onclick={() => close(false)}>{t('undo.confirm.cancel')}</button>
    <button type="button" class="btn btn-primary" data-testid="undo-confirm-btn" disabled={busy} onclick={() => void confirm()}>{t('undo.confirm.confirm')}</button>
  {/snippet}
</DialogShell>

<style>
  .description {
    margin: 8px 0 0;
  }
</style>
