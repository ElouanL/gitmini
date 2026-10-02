<script lang="ts">
  // `push-rejected-dialog[data-stale]` (10 § Push, releases): opened by `handleError` on `REJECTED_NON_FF { operation: "push" }`.
  // - `stale=false` (`non-fast-forward`, `fetch first`): the local remote-tracking is late → Pull (`remote_pull` without mode, without pushing back);
  // - `stale=true` (exceeded release): the remote branch has changed since the last fetch → Fetch of the affected remote. Nothing is overwritten.
  import type { DialogProps } from '$lib/dialogs/registry';
  import type { AppError } from '$lib/ipc/types';
  import { t } from '$i18n/index';
  import DialogShell from '$lib/components/dialogs-base/DialogShell.svelte';
  import { fetchNamed, pullRun } from './sync';

  interface Props extends DialogProps<boolean> {
    error: AppError;
    command?: string;
    retry?: () => unknown;
    data?: { remote?: string; branch?: string; remoteBranch?: string };
  }

  let { error, data, close }: Props = $props();

  const stale = $derived(error.details?.stale === true);
  const remote = $derived(
    typeof error.details?.remote === 'string' ? error.details.remote : (data?.remote ?? null),
  );
  const branch = $derived(
    typeof error.details?.branch === 'string' ? error.details.branch : (data?.remoteBranch ?? data?.branch ?? ''),
  );
  const ref = $derived(remote && branch ? `${remote}/${branch}` : (branch || remote || ''));

  function pull(): void {
    close(true);
    void pullRun();
  }

  function fetchRemote(): void {
    close(true);
    void fetchNamed(remote);
  }
</script>

<DialogShell testid="push-rejected-dialog" title={t('remotes.rejected.title')} attrs={{ 'data-stale': String(stale) }} width={460} onclose={() => close()}>
  <p class="message" data-testid="push-rejected-message">
    {stale ? t('remotes.rejected.stale') : t('remotes.rejected.fastForward', { ref })}
  </p>
  {#snippet footer()}
    <button type="button" class="btn" data-testid="push-rejected-cancel-btn" onclick={() => close()}>{t('remotes.rejected.cancel')}</button>
    {#if stale}
      <button type="button" class="btn btn-primary" data-testid="push-rejected-fetch-btn" data-autofocus onclick={fetchRemote}>{t('remotes.rejected.fetch')}</button>
    {:else}
      <button type="button" class="btn btn-primary" data-testid="push-rejected-pull-btn" data-autofocus onclick={pull}>{t('remotes.rejected.pull')}</button>
    {/if}
  {/snippet}
</DialogShell>

<style>
  .message {
    margin: 8px 0 0;
  }
</style>
