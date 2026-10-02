<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { repo } = captureStores();
  // `stash-save-dialog` (08 §stash dialog): message, files not tracked (default checked), keep index, and — started from a
  // selection of `wt-panel` — list of paths removed one by one. Valid by `stash_save`; path errors under the list.
  import type { DialogProps } from '$lib/dialogs/registry';
  import type { AppError } from '$lib/ipc/types';

  import { t } from '$i18n/index';
  import DialogShell from '$lib/components/dialogs-base/DialogShell.svelte';
  import { saveStash } from './stash-ops';

  interface Props extends DialogProps<boolean> {
    /** Paths to set aside (menu `wt-file`); empty or absent = the entire worktree. */
    paths?: string[];
  }

  let { paths = [], close }: Props = $props();

  let message = $state('');
  let includeUntracked = $state(true);
  let keepIndex = $state(false);
  // Local copy: the dialog removes paths without touching the caller list.
  // svelte-ignore state_referenced_locally
  let selected = $state<string[]>([...paths]);
  let busy = $state(false);
  let error = $state<string | null>(null);

  const hasPaths = $derived(paths.length > 0);
  const branch = $derived(repo.head?.branch ?? 'HEAD');
  const canSubmit = $derived(!busy && (!hasPaths || selected.length > 0));

  function remove(path: string): void {
    selected = selected.filter((p) => p !== path);
  }

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    busy = true;
    error = null;
    const res = await saveStash(
      { message, includeUntracked, keepIndex, ...(hasPaths ? { paths: selected } : {}) },
      (e: AppError) => {
        // Submodule or path not UTF-8: error under the path list (08 § Error box).
        if (e.code === 'INVALID_ARGUMENT' && e.details?.field === 'paths') {
          error = e.message;
          return true;
        }
        return false;
      },
    );
    busy = false;
    if (res) close(true);
  }
</script>

<DialogShell testid="stash-save-dialog" title={t('stash.save.title')} width={460} onclose={() => close()} onsubmit={() => void submit()}>
  <div class="field">
    <label for="stash-message">{t('stash.save.message')}</label>
    <input
      id="stash-message"
      class="input"
      data-testid="stash-message-input"
      data-autofocus
      placeholder={t('stash.save.messagePlaceholder', { branch })}
      bind:value={message}
    />
  </div>

  {#if hasPaths}
    <div class="field">
      <span class="field-label">{t('stash.save.paths')}</span>
      <ul class="paths" data-testid="stash-paths-list">
        {#each selected as path (path)}
          <li class="path" data-testid="stash-paths-item" data-path={path}>
            <span class="truncate mono" title={path}>{path}</span>
            <button type="button" class="icon-btn" data-testid="stash-paths-remove-btn" aria-label={t('stash.save.removePath', { path })} title={t('stash.save.removePath', { path })} onclick={() => remove(path)}>×</button>
          </li>
        {/each}
      </ul>
      {#if error}<span class="field-error" data-testid="stash-save-error" role="alert">{error}</span>{/if}
    </div>
  {/if}

  <label class="checkbox">
    <input type="checkbox" data-testid="stash-include-untracked-checkbox" bind:checked={includeUntracked} />
    {t('stash.save.includeUntracked')}
  </label>
  <label class="checkbox">
    <input type="checkbox" data-testid="stash-keep-index-checkbox" bind:checked={keepIndex} />
    {t('stash.save.keepIndex')}
  </label>

  {#snippet footer()}
    <button type="button" class="btn" data-testid="stash-save-cancel-btn" onclick={() => close()}>{t('stash.save.cancel')}</button>
    <button type="button" class="btn btn-primary" data-testid="stash-save-confirm-btn" disabled={!canSubmit} onclick={() => void submit()}>{t('stash.save.confirm')}</button>
  {/snippet}
</DialogShell>

<style>
  .paths {
    max-height: 160px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .path {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 0 4px 0 8px;
    min-height: 26px;
  }
  .path + .path {
    border-top: 1px solid var(--border);
  }
  .checkbox {
    margin-bottom: 6px;
  }
</style>
