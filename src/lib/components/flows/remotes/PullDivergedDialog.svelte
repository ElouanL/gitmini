<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { refs } = captureStores();
  // `pull-diverged-dialog` (10 §Push and pull): `REJECTED_NON_FF { operation: "pull", diverged: true }` (fetch took place, no merge
  // Proposes pull in rebase (`pull-diverged-rebase-btn`) mode; a pull never creates any commit in merge.
  import type { DialogProps } from '$lib/dialogs/registry';
  import type { AppError } from '$lib/ipc/types';

  import { t } from '$i18n/index';
  import DialogShell from '$lib/components/dialogs-base/DialogShell.svelte';
  import { onMount } from 'svelte';
  import { pullRun } from './sync';

  interface Props extends DialogProps<boolean> {
    error: AppError;
    command?: string;
    retry?: () => unknown;
    data?: Record<string, unknown>;
  }

  let { error, close }: Props = $props();

  // The fetch has just taken place: the current branch's ↑▼ meters are read (the divergence also appears in the graph).
  onMount(() => {
    void refs.reloadRefs();
  });

  const current = $derived(refs.currentBranch);
  const branch = $derived(
    typeof error.details?.branch === 'string' ? error.details.branch : (current?.name ?? ''),
  );
  const upstream = $derived(current?.upstream?.ref ?? t('remotes.pull.upstreamFallback'));
  const ahead = $derived(current?.upstream?.ahead ?? null);
  const behind = $derived(current?.upstream?.behind ?? null);
  const counts = $derived(ahead !== null && behind !== null && ahead > 0 && behind > 0);

  function rebase(): void {
    close(true);
    void pullRun({ mode: 'rebase' });
  }
</script>

<DialogShell testid="pull-diverged-dialog" title={t('remotes.diverged.title')} width={460} onclose={() => close()}>
  <p class="message" data-testid="pull-diverged-message">
    {counts
      ? t('remotes.diverged.message', { branch, upstream, ahead: ahead ?? 0, behind: behind ?? 0 })
      : t('remotes.diverged.message.noCounts', { branch, upstream })}
  </p>
  {#snippet footer()}
    <button type="button" class="btn" data-testid="pull-dialog-cancel-btn" onclick={() => close()}>{t('remotes.pull.cancel')}</button>
    <button type="button" class="btn btn-primary" data-testid="pull-diverged-rebase-btn" data-autofocus onclick={rebase}>{t('remotes.diverged.rebase')}</button>
  {/snippet}
</DialogShell>

<style>
  .message {
    margin: 8px 0 0;
  }
</style>
