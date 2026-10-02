<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { op } = captureStores();
  // `branch-delete-force-dialog` (06): Opened by `handleError` on `NOT_MERGED { name, commits }` (props `{ error, data }`).
  // "Delete anyway" restarts `branch_delete { force: true }`; the undo is offered by the 10 s toast.
  import { t } from '$i18n/index';
  import DialogShell from '$lib/components/dialogs-base/DialogShell.svelte';
  import type { DialogProps } from '$lib/dialogs/registry';
  import type { AppError } from '$lib/ipc/types';

  import { deleteBranch, notMergedMessage } from './ops';

  interface Props extends DialogProps<boolean> {
    error?: AppError;
    data?: Record<string, unknown>;
  }

  let { error, data, close }: Props = $props();

  const name = $derived(
    typeof error?.details?.name === 'string' ? error.details.name : typeof data?.name === 'string' ? data.name : '',
  );
  const commits = $derived(typeof error?.details?.commits === 'number' ? error.details.commits : 0);
  let busy = $state(false);

  async function confirm(): Promise<void> {
    if (busy || !name) return;
    busy = true;
    const ok = await deleteBranch(name, true);
    busy = false;
    close(ok);
  }
</script>

<DialogShell testid="branch-delete-force-dialog" title={t('branches.deleteForce.title')} danger onclose={() => close()}>
  <p class="message">{notMergedMessage(name, commits)}</p>
  {#snippet footer()}
    <!-- Danger: initial focus on Cancel . -->
    <button type="button" class="btn" data-autofocus data-testid="branch-delete-force-cancel-btn" onclick={() => close()}>
      {t('branches.deleteForce.cancel')}
    </button>
    <button
      type="button"
      class="btn btn-danger"
      data-testid="branch-delete-force-btn"
      disabled={busy || op.busy}
      onclick={() => void confirm()}
    >
      {t('branches.deleteForce.confirm')}
    </button>
  {/snippet}
</DialogShell>

<style>
  .message {
    margin: 8px 0 0;
  }
</style>
