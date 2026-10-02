<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { refs } = captureStores();
  // `push-dialog` (10 §Push and pull): open only if the branch does not have an upstream. Remote target (default `origin`, if not the first),
  // Remote name (default: local branch), "Defining the upstream" checked. The dialog closes and then launches the push [L]: progression
  // and cancellation are visible in the toolbar (`toolbar-op-progress`, `toolbar-op-cancel-btn`).
  import type { DialogProps } from '$lib/dialogs/registry';

  import { t } from '$i18n/index';
  import DialogShell from '$lib/components/dialogs-base/DialogShell.svelte';
  import { defaultPushRemote, remoteBranchProblem } from './remote-logic';
  import { pushRun } from './sync';

  interface Props extends DialogProps<boolean> {
    /** Local branch to push. */
    branch: string;
  }

  let { branch, close }: Props = $props();

  const remotes = $derived(refs.remotes);
  let remote = $state(defaultPushRemote(refs.remotes) ?? '');
  // svelte-ignore state_referenced_locally
  let remoteBranch = $state(branch);
  let setUpstream = $state(true);
  let touched = $state(false);

  const problem = $derived(remoteBranchProblem(remoteBranch));
  const canSubmit = $derived(remote !== '' && problem === null);

  function submit(): void {
    touched = true;
    if (!canSubmit) return;
    close(true);
    void pushRun({ remote, branch, remoteBranch: remoteBranch.trim(), setUpstream, forceWithLease: false });
  }
</script>

<DialogShell testid="push-dialog" title={t('remotes.push.title', { branch })} width={440} onclose={() => close()} onsubmit={submit}>
  <div class="field">
    <label for="push-remote">{t('remotes.push.remote')}</label>
    <select id="push-remote" class="select" data-testid="push-remote-select" bind:value={remote}>
      {#each remotes as r (r.name)}
        <option value={r.name}>{r.name}</option>
      {/each}
    </select>
  </div>
  <div class="field">
    <label for="push-remote-branch">{t('remotes.push.remoteBranch')}</label>
    <input
      id="push-remote-branch"
      class="input"
      data-testid="push-remote-branch-input"
      data-autofocus
      aria-invalid={touched && problem ? 'true' : undefined}
      bind:value={remoteBranch}
    />
    {#if touched && problem}<span class="field-error" role="alert">{t(`remotes.push.error.${problem}`)}</span>{/if}
  </div>
  <label class="checkbox">
    <input type="checkbox" data-testid="push-set-upstream-toggle" bind:checked={setUpstream} />
    {t('remotes.push.setUpstream')}
  </label>
  {#snippet footer()}
    <button type="button" class="btn" data-testid="push-cancel-btn" onclick={() => close()}>{t('remotes.push.cancel')}</button>
    <button type="button" class="btn btn-primary" data-testid="push-submit-btn" disabled={remote === ''} onclick={submit}>{t('remotes.push.submit')}</button>
  {/snippet}
</DialogShell>
