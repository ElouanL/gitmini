<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { op, refs, repo, runWrite } = captureStores();
  // `checkout-remote-name-dialog` (06 "Remote Branch") : the local name of the remote branch already exists without following it
  // (`ALREADY_EXISTS`). `origin-feature` is proposed, then `branch_checkout { kind: "remote", ref, localName }`.
  import { untrack } from 'svelte';
  import { t } from '$i18n/index';
  import DialogShell from '$lib/components/dialogs-base/DialogShell.svelte';
  import type { DialogProps } from '$lib/dialogs/registry';
  import { commands } from '$lib/ipc/commands';

  import { fieldErrorMessage, normalizeBranchInput, problemMessage, suggestLocalName, validateBranchName } from './names';

  interface Props extends DialogProps<boolean> {
    /** Remote branch to extract (`origin/feature`). */
    remoteRef: string;
    /** Local name that caused the collision (`feature`). */
    name?: string;
  }

  let { remoteRef, name: taken = '', close }: Props = $props();

  let value = $state(untrack(() => suggestLocalName(remoteRef)));
  let serverError = $state<string | null>(null);
  let busy = $state(false);

  const problem = $derived(validateBranchName(value));
  const error = $derived(serverError ?? (problem ? problemMessage(problem) : null));
  const canSubmit = $derived(value !== '' && problem === null && !busy && !op.busy);
  const inputId = `checkout-remote-name-${Math.random().toString(36).slice(2, 8)}`;

  function onInput(e: Event & { currentTarget: HTMLInputElement }): void {
    const el = e.currentTarget;
    const normalized = normalizeBranchInput(el.value);
    if (normalized !== el.value) el.value = normalized;
    value = normalized;
    serverError = null;
  }

  async function submit(): Promise<void> {
    const repoId = repo.id;
    if (!canSubmit || repoId === null) return;
    busy = true;
    serverError = null;
    const localName = value;
    const target = { kind: 'remote' as const, ref: remoteRef, localName };
    const res = await runWrite(t('branches.op.checkout'), () => commands.branchCheckout({ repoId, target }), {
      command: 'branch_checkout',
      // A `DIRTY_WORKTREE` opens `checkout-dirty-dialog` with this target (localName included).
      data: { target },
      onError: (e) => {
        if (e.code === 'ALREADY_EXISTS') {
          serverError = t('branches.name.exists', { name: localName });
          return true;
        }
        // `branch_checkout { kind: "remote", localName }` names its field `localName`.
        const fieldError = fieldErrorMessage(e, ['localName']);
        if (fieldError !== null) {
          serverError = fieldError;
          return true;
        }
        return false;
      },
    });
    busy = false;
    if (res.ok) {
      refs.apply(res.value);
      close(true);
    }
  }
</script>

<DialogShell testid="checkout-remote-name-dialog" title={t('branches.checkoutRemote.title')} onclose={() => close()} onsubmit={() => void submit()}>
  <p class="message">{t('branches.checkoutRemote.message', { name: taken || remoteRef.replace(/^[^/]+\//, ''), ref: remoteRef })}</p>
  <div class="field">
    <label for={inputId}>{t('branches.checkoutRemote.title')}</label>
    <input
      id={inputId}
      class="input"
      type="text"
      autocomplete="off"
      spellcheck="false"
      data-autofocus
      data-testid="checkout-remote-name-input"
      {value}
      aria-invalid={error ? 'true' : undefined}
      oninput={onInput}
    />
    {#if error}
      <div class="field-error" role="alert" data-testid="checkout-remote-name-error">{error}</div>
    {/if}
  </div>

  {#snippet footer()}
    <button type="button" class="btn" data-testid="checkout-remote-name-cancel-btn" onclick={() => close()}>
      {t('branches.checkoutRemote.cancel')}
    </button>
    <button type="button" class="btn btn-primary" data-testid="checkout-remote-name-submit-btn" disabled={!canSubmit} onclick={() => void submit()}>
      {t('branches.checkoutRemote.submit')}
    </button>
  {/snippet}
</DialogShell>

<style>
  .message {
    margin: 8px 0 12px;
  }
</style>
