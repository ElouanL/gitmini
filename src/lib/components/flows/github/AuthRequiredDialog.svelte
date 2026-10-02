<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { refs } = captureStores();
  // `auth-required-dialog` + `auth-required-close-btn` (10 §In error box): opened by `handleError` on `AUTH_REQUIRED` of a git command
  // (never prompt: git is run without a terminal). `github-login-btn` if URL is HTTPS on the host GitHub: after a successful connection,
  // the command that had failed is restarted (`retry`).
  import type { DialogProps } from '$lib/dialogs/registry';
  import { openDialog } from '$lib/dialogs/registry';
  import { featureFlags } from '$lib/feature-flags';
  import type { AppError } from '$lib/ipc/types';

  import { t } from '$i18n/index';
  import DialogShell from '$lib/components/dialogs-base/DialogShell.svelte';
  import { authDetails, authMessage, offersGithubLogin, remoteFor } from './auth-text';

  interface Props extends DialogProps<boolean> {
    error: AppError;
    command?: string;
    retry?: () => unknown;
    data?: Record<string, unknown>;
  }

  let { error, retry, close }: Props = $props();

  const details = $derived(authDetails(error));
  const remote = $derived(remoteFor(details, refs.remotes));
  const message = $derived(authMessage(error, refs.remotes));
  const loginOffered = $derived(featureFlags.githubLogin && offersGithubLogin(details, remote));

  async function login(): Promise<void> {
    const ok = await openDialog<boolean>('github-login-dialog');
    if (ok === true) {
      close(true);
      void retry?.();
    }
  }
</script>

<DialogShell testid="auth-required-dialog" title={t('auth.title')} attrs={{ 'data-reason': details.reason }} width={460} onclose={() => close(false)}>
  <p class="message" data-testid="auth-required-message">{message}</p>
  {#snippet footer()}
    <button type="button" class="btn" data-testid="auth-required-close-btn" onclick={() => close(false)}>{t('auth.close')}</button>
    {#if loginOffered}
      <button type="button" class="btn btn-primary" data-testid="github-login-btn" data-autofocus onclick={() => void login()}>{t('auth.login')}</button>
    {/if}
  {/snippet}
</DialogShell>

<style>
  .message {
    margin: 8px 0 0;
  }
</style>
