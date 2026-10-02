<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { reportError } = captureStores();
  // `github-login-dialog[data-state=starting|waiting|success|expired|denied|error]` (10 §GitHub : connexion, Device Flow).
  // `github_login_start` → displays `userCode` (copyed in clipboard) and opens the one page times → `github_login_poll`
  // in loop (backend waits for interval) → account badge, closing after 1 sec. Cancel / close stop the loop.
  import { onDestroy, onMount } from 'svelte';
  import { copyText } from '$lib/clipboard';
  import type { DialogProps } from '$lib/dialogs/registry';

  import { commands } from '$lib/ipc/commands';
  import type { GithubLoginStart } from '$lib/ipc/types';
  import { github } from '$lib/stores/github.svelte';
  import { t } from '$i18n/index';
  import DialogShell from '$lib/components/dialogs-base/DialogShell.svelte';
  import { canRetryLogin, driveDeviceFlow, type LoginState } from './device-flow';

  let { close }: DialogProps<boolean> = $props();

  let phase = $state<LoginState>('starting');
  let code = $state('');
  let verificationUri = $state('');
  let login = $state<string | null>(null);
  let message = $state('');
  let cancelled = false;
  let runId = 0;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const errorText = $derived.by(() => {
    if (phase === 'expired') return t('github.login.expired');
    if (phase === 'denied') return t('github.login.denied');
    if (phase === 'error') return t('github.login.error', { message });
    return '';
  });

  function openPage(uri = verificationUri): void {
    if (!uri) return;
    commands.openExternal({ target: { kind: 'url', url: uri } }).catch((e: unknown) => reportError(e, { command: 'open_external' }));
  }

  async function run(): Promise<void> {
    const mine = ++runId;
    phase = 'starting';
    code = '';
    message = '';
    const stale = (): boolean => cancelled || mine !== runId;
    await driveDeviceFlow({
      start: () => commands.githubLoginStart(),
      poll: (loginId) => commands.githubLoginPoll({ loginId }),
      cancelled: stale,
      onStarted: (s: GithubLoginStart) => {
        code = s.userCode;
        verificationUri = s.verificationUri;
        // Copied to display; the verification page is opened automatically, only once per attempt.
        void copyText(s.userCode, { silent: true });
        openPage(s.verificationUri);
      },
      onState: (s, detail) => {
        phase = s;
        if (detail.message) message = detail.message;
        if (s === 'success') {
          login = detail.login ?? null;
          github.setLoggedIn(login);
          closeTimer = setTimeout(() => close(true), 1000);
        }
      },
      onLateSuccess: (l) => github.setLoggedIn(l),
    });
  }

  onMount(() => {
    void run();
  });

  onDestroy(() => {
    cancelled = true;
    if (closeTimer) clearTimeout(closeTimer);
  });
</script>

<DialogShell testid="github-login-dialog" title={t('github.login.title')} attrs={{ 'data-state': phase }} width={440} onclose={() => close(phase === 'success')}>
  {#if phase === 'starting'}
    <p class="info muted">{t('github.login.starting')}</p>
  {:else if phase === 'waiting'}
    <p class="info">{t('github.login.waiting')}</p>
    <p class="code mono" data-testid="github-device-code">{code}</p>
    <div class="row">
      <button type="button" class="btn" data-testid="github-device-copy-btn" onclick={() => void copyText(code)}>{t('github.login.copy')}</button>
      <button type="button" class="btn" data-testid="github-device-open-btn" onclick={() => openPage()}>{t('github.login.open')}</button>
    </div>
    <p class="muted hint">{t('github.login.waitingHint')}</p>
  {:else if phase === 'success'}
    <p class="info" data-testid="github-login-success">{login ? t('github.login.success', { login }) : t('github.login.success.noLogin')}</p>
    {#if login}<p class="badge-row"><span class="badge" data-testid="github-account-badge">{login}</span></p>{/if}
  {:else}
    <p class="error" data-testid="github-login-error" role="alert">{errorText}</p>
  {/if}

  {#snippet footer()}
    {#if canRetryLogin(phase)}
      <button type="button" class="btn btn-primary" data-testid="github-login-retry-btn" data-autofocus onclick={() => void run()}>{t('github.login.retry')}</button>
    {/if}
    <button type="button" class="btn" data-testid="github-login-cancel-btn" onclick={() => close(phase === 'success')}>
      {phase === 'success' || canRetryLogin(phase) ? t('github.login.close') : t('github.login.cancel')}
    </button>
  {/snippet}
</DialogShell>

<style>
  .info {
    margin: 8px 0;
  }
  .code {
    margin: 8px 0 12px;
    padding: 10px 12px;
    text-align: center;
    font-size: 24px;
    font-weight: 700;
    letter-spacing: 0.12em;
    border: 1px dashed var(--border);
    border-radius: var(--radius);
    user-select: all;
  }
  .row {
    display: flex;
    gap: 8px;
    justify-content: center;
  }
  .hint {
    margin: 12px 0 0;
    text-align: center;
  }
  .error {
    margin: 8px 0;
    color: var(--danger);
  }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--bg-elev);
    font-weight: 600;
  }
  .badge-row {
    margin: 0;
  }
</style>
