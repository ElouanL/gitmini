<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { op, refs, repo, runWrite } = captureStores();
  // `branch-create-dialog` (06 "Create a branch") : name validated live as gix side, starting point for reading
  // checkout option. `ALREADY_EXISTS` / `INVALID_ARGUMENT` is displayed SOUS the field; a `DIRTY_WORKTREE` with
  // checkout ouvre `checkout-dirty-dialog` (autostash).
  import { untrack } from 'svelte';
  import { t } from '$i18n/index';
  import DialogShell from '$lib/components/dialogs-base/DialogShell.svelte';
  import { openDialog, type DialogProps } from '$lib/dialogs/registry';
  import { commands } from '$lib/ipc/commands';
  import type { AppError } from '$lib/ipc/types';

  import { fieldErrorMessage, normalizeBranchInput, problemMessage, validateBranchName } from './names';
  import { startPointLabel } from './ops';

  interface Props extends DialogProps<boolean> {
    /** `null` = HEAD (the backend resolves it); `'HEAD'` = the oid of HEAD; otherwise the name ref or oid. */
    startPoint?: string | null;
    /** Check box "toggle" at opening (default: yes). */
    checkout?: boolean;
  }

  let { startPoint = null, checkout: checkoutDefault = true, close }: Props = $props();

  // `'HEAD'` (`branch-create-here-btn`, toast `DETACHED_HEAD`): the Oid of HEAD is sent, not a symbolic ref; `null` = HEAD for backend.
  const startRef = untrack(() => (startPoint === 'HEAD' ? (repo.head?.oid ?? null) : startPoint));
  const startLabel = untrack(() => startPointLabel(startPoint));

  let name = $state('');
  let checkout = $state(untrack(() => checkoutDefault));
  let serverError = $state<string | null>(null);
  let busy = $state(false);

  const problem = $derived(validateBranchName(name));
  const error = $derived(serverError ?? (problem ? problemMessage(problem) : null));
  const canSubmit = $derived(name !== '' && problem === null && !busy && !op.busy);
  const inputId = `branch-create-name-${Math.random().toString(36).slice(2, 8)}`;

  function existsMessage(e: AppError): string {
    const blockedBy = typeof e.details?.blockedBy === 'string' ? e.details.blockedBy : null;
    return blockedBy ? t('branches.name.blockedBy', { blockedBy, name }) : t('branches.name.exists', { name });
  }

  function onInput(e: Event & { currentTarget: HTMLInputElement }): void {
    const el = e.currentTarget;
    const normalized = normalizeBranchInput(el.value);
    if (normalized !== el.value) el.value = normalized;
    name = normalized;
    serverError = null;
  }

  async function submit(): Promise<void> {
    const repoId = repo.id;
    if (!canSubmit || repoId === null) return;
    busy = true;
    serverError = null;
    const flow: { dirty: AppError | null } = { dirty: null };
    const created = name;
    const res = await runWrite(
      t('branches.op.create'),
      () => commands.branchCreate({ repoId, name: created, startPoint: startRef, checkout }),
      {
        command: 'branch_create',
        data: { create: { name: created, startPoint: startRef } },
        onError: (e) => {
          if (e.code === 'ALREADY_EXISTS') {
            serverError = existsMessage(e);
            return true;
          }
          // Fields covered by `branch_create`: name, starting point, autostash (06 "Validation of names").
          const fieldError = fieldErrorMessage(e, ['name', 'startPoint', 'autoStash']);
          if (fieldError !== null) {
            serverError = fieldError;
            return true;
          }
          if (e.code === 'DIRTY_WORKTREE' && checkout) {
            flow.dirty = e;
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
      return;
    }
    if (flow.dirty) {
      const done = await openDialog<boolean>('checkout-dirty-dialog', {
        error: flow.dirty,
        command: 'branch_create',
        data: { create: { name: created, startPoint: startRef } },
      });
      if (done) close(true);
    }
  }
</script>

<DialogShell testid="branch-create-dialog" title={t('branches.create.title')} onclose={() => close()} onsubmit={() => void submit()}>
  <div class="field">
    <label for={inputId}>{t('branches.create.name')}</label>
    <input
      id={inputId}
      class="input"
      type="text"
      autocomplete="off"
      spellcheck="false"
      data-autofocus
      data-testid="branch-create-name-input"
      placeholder={t('branches.create.namePlaceholder')}
      value={name}
      aria-invalid={error ? 'true' : undefined}
      oninput={onInput}
    />
    {#if error}
      <div class="field-error" role="alert" data-testid="branch-create-error">{error}</div>
    {/if}
  </div>
  <div class="field">
    <span class="field-label">{t('branches.create.startPoint')}</span>
    <div class="start truncate" data-testid="branch-create-start-point" title={startLabel}>{startLabel}</div>
  </div>
  <label class="checkbox">
    <input type="checkbox" data-testid="branch-create-checkout-toggle" bind:checked={checkout} />
    <span>{t('branches.create.checkout')}</span>
  </label>

  {#snippet footer()}
    <button type="button" class="btn" data-testid="branch-create-cancel-btn" onclick={() => close()}>{t('branches.create.cancel')}</button>
    <button type="button" class="btn btn-primary" data-testid="branch-create-submit-btn" disabled={!canSubmit} onclick={() => void submit()}>
      {t('branches.create.submit')}
    </button>
  {/snippet}
</DialogShell>

<style>
  .start {
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-elev);
    font-family: var(--font-mono);
    font-size: 12px;
  }
</style>
