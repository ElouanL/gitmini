<script lang="ts">
  // `pull-autostash-dialog` (10 §Push and pull): `DIRTY_WORKTREE` of a pull in rebase mode (modifications followed, not followed).
  // "N modified files prevent sweater. Relaunch with autostash?": `pull-autostash-btn` restarts with the same mode and `autostash: true`.
  import type { DialogProps } from '$lib/dialogs/registry';
  import type { AppError } from '$lib/ipc/types';
  import { t, tp } from '$i18n/index';
  import DialogShell from '$lib/components/dialogs-base/DialogShell.svelte';
  import { pullRun } from './sync';

  interface Props extends DialogProps<boolean> {
    error: AppError;
    command?: string;
    retry?: () => unknown;
    data?: { mode?: 'ff-only' | 'rebase' | null };
  }

  let { error, data, close }: Props = $props();

  const paths = $derived(Array.isArray(error.details?.paths) ? (error.details.paths as unknown[]).filter((p): p is string => typeof p === 'string') : []);
  // `details.paths` is capped at 20: the real number is at the top of the backend message ("31 modified files prevent the pull").
  const n = $derived(Number(/^(\d+)\s/u.exec(error.message)?.[1]) || Math.max(paths.length, 1));

  function relaunch(): void {
    close(true);
    void pullRun({ ...(data?.mode ? { mode: data.mode } : {}), autostash: true });
  }
</script>

<DialogShell testid="pull-autostash-dialog" title={t('remotes.autostash.title')} width={460} onclose={() => close()}>
  <p class="message" data-testid="pull-autostash-message">{tp('remotes.autostash.message', n)}</p>
  {#if paths.length > 0}
    <ul class="paths mono">
      {#each paths.slice(0, 8) as p (p)}<li class="truncate" title={p}>{p}</li>{/each}
      {#if paths.length > 8}<li class="muted">…</li>{/if}
    </ul>
  {/if}
  {#snippet footer()}
    <button type="button" class="btn" data-testid="pull-dialog-cancel-btn" onclick={() => close()}>{t('remotes.pull.cancel')}</button>
    <button type="button" class="btn btn-primary" data-testid="pull-autostash-btn" data-autofocus onclick={relaunch}>{t('remotes.autostash.relaunch')}</button>
  {/snippet}
</DialogShell>

<style>
  .message {
    margin: 8px 0 6px;
  }
  .paths {
    margin: 0;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 12px;
  }
</style>
