<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { op, refs, repo, runWrite } = captureStores();
  // `branch-rename-dialog` (06 "Rename") : pre-filled field, selected text; remote branch is not known.
  import { onMount, untrack } from 'svelte';
  import { t } from '$i18n/index';
  import DialogShell from '$lib/components/dialogs-base/DialogShell.svelte';
  import type { DialogProps } from '$lib/dialogs/registry';
  import { commands } from '$lib/ipc/commands';
  import type { AppError } from '$lib/ipc/types';

  import { toast } from '$lib/stores/toast.svelte';
  import { fieldErrorMessage, normalizeBranchInput, problemMessage, validateBranchName } from './names';

  interface Props extends DialogProps<boolean> {
    /** Short name of the local branch to be renamed. */
    name: string;
  }

  let { name: oldName, close }: Props = $props();

  let value = $state(untrack(() => oldName));
  let serverError = $state<string | null>(null);
  let busy = $state(false);
  let input = $state<HTMLInputElement | undefined>();

  const upstream = $derived(refs.snapshot?.local.find((b) => b.name === oldName)?.upstream ?? null);
  const problem = $derived(validateBranchName(value));
  const error = $derived(serverError ?? (problem ? problemMessage(problem) : null));
  const unchanged = $derived(value === oldName);
  const canSubmit = $derived(value !== '' && problem === null && !unchanged && !busy && !op.busy);
  const inputId = `branch-rename-${Math.random().toString(36).slice(2, 8)}`;

  onMount(() => {
    input?.select();
  });

  function existsMessage(e: AppError): string {
    const blockedBy = typeof e.details?.blockedBy === 'string' ? e.details.blockedBy : null;
    return blockedBy ? t('branches.name.blockedBy', { blockedBy, name: value }) : t('branches.name.exists', { name: value });
  }

  function onInput(e: Event & { currentTarget: HTMLInputElement }): void {
    const el = e.currentTarget;
    const normalized = normalizeBranchInput(el.value);
    if (normalized !== el.value) el.value = normalized;
    value = normalized;
    serverError = null;
  }

  async function submit(): Promise<void> {
    const repoId = repo.id;
    if (repoId === null) return;
    if (unchanged) {
      close();
      return;
    }
    if (!canSubmit) return;
    busy = true;
    serverError = null;
    const newName = value;
    const res = await runWrite(
      t('branches.op.rename'),
      () => commands.branchRename({ repoId, oldName, newName }),
      {
        command: 'branch_rename',
        onError: (e) => {
          if (e.code === 'ALREADY_EXISTS') {
            serverError = existsMessage(e);
            return true;
          }
          // `branch_rename` names its `oldName` and `newName` fields.
          const fieldError = fieldErrorMessage(e, ['newName', 'oldName']);
          if (fieldError !== null) {
            serverError = fieldError;
            return true;
          }
          if (e.code === 'NOT_FOUND') {
            toast.info(t('branches.rename.gone', { name: oldName }));
            void refs.reloadRefs();
            close();
            return true;
          }
          return false;
        },
      },
    );
    busy = false;
    if (res.ok) {
      refs.apply(res.value);
      close(true);
    }
  }
</script>

<DialogShell testid="branch-rename-dialog" title={t('branches.rename.title', { name: oldName })} onclose={() => close()} onsubmit={() => void submit()}>
  <div class="field">
    <label for={inputId}>{t('branches.rename.label')}</label>
    <input
      id={inputId}
      bind:this={input}
      class="input"
      type="text"
      autocomplete="off"
      spellcheck="false"
      data-autofocus
      data-testid="branch-rename-input"
      {value}
      aria-invalid={error ? 'true' : undefined}
      oninput={onInput}
    />
    {#if error}
      <div class="field-error" role="alert" data-testid="branch-rename-error">{error}</div>
    {/if}
  </div>
  {#if upstream}
    <p class="muted note" data-testid="branch-rename-upstream-note">{t('branches.rename.upstreamKept', { upstream: upstream.ref })}</p>
  {/if}

  {#snippet footer()}
    <button type="button" class="btn" data-testid="branch-rename-cancel-btn" onclick={() => close()}>{t('branches.rename.cancel')}</button>
    <button type="button" class="btn btn-primary" data-testid="branch-rename-submit-btn" disabled={!canSubmit} onclick={() => void submit()}>
      {t('branches.rename.submit')}
    </button>
  {/snippet}
</DialogShell>

<style>
  .note {
    margin: 0;
    font-size: 12px;
  }
</style>
