<script lang="ts">
  // `stash-branch-dialog` (08 §Break from stash): proposed name `stash/<branche-origine>-<n>`; `INVALID_ARGUMENT { field: "name" }`
  // and `ALREADY_EXISTS { what: "branch" }` are displayed in `stash-branch-error`, under the field.
  import type { DialogProps } from '$lib/dialogs/registry';
  import type { AppError, StashEntry } from '$lib/ipc/types';
  import { t } from '$i18n/index';
  import DialogShell from '$lib/components/dialogs-base/DialogShell.svelte';
  import { branchFromStash } from './stash-ops';
  import { branchNameProblem, defaultStashBranchName } from './stash-text';

  interface Props extends DialogProps<boolean> {
    stash: StashEntry;
  }

  let { stash, close }: Props = $props();

  // svelte-ignore state_referenced_locally
  let name = $state(defaultStashBranchName(stash));
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function submit(): Promise<void> {
    if (busy) return;
    const value = name.trim();
    if (branchNameProblem(value)) {
      error = t('stash.branchDialog.empty');
      return;
    }
    busy = true;
    error = null;
    const ok = await branchFromStash(stash, value, (e: AppError) => {
      if (e.code === 'ALREADY_EXISTS' && e.details?.what === 'branch') {
        error = t('stash.branchDialog.exists', { name: String(e.details.name ?? value) });
        return true;
      }
      if (e.code === 'INVALID_ARGUMENT' && e.details?.field === 'name') {
        error = e.message;
        return true;
      }
      return false;
    });
    busy = false;
    if (ok) close(true);
  }
</script>

<DialogShell testid="stash-branch-dialog" title={t('stash.branchDialog.title')} width={440} onclose={() => close()} onsubmit={() => void submit()}>
  <div class="field">
    <label for="stash-branch-name">{t('stash.branchDialog.name')}</label>
    <input
      id="stash-branch-name"
      class="input"
      data-testid="stash-branch-name-input"
      data-autofocus
      aria-invalid={error ? 'true' : undefined}
      bind:value={name}
      oninput={() => (error = null)}
    />
    {#if error}<span class="field-error" data-testid="stash-branch-error" role="alert">{error}</span>{/if}
  </div>
  {#snippet footer()}
    <button type="button" class="btn" data-testid="stash-branch-cancel-btn" onclick={() => close()}>{t('stash.branchDialog.cancel')}</button>
    <button type="button" class="btn btn-primary" data-testid="stash-branch-confirm-btn" disabled={busy} onclick={() => void submit()}>{t('stash.branchDialog.confirm')}</button>
  {/snippet}
</DialogShell>
