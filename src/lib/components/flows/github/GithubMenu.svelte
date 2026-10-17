<script lang="ts">
  // `github-menu` (10 §GitHub): popover `toolbar-github-btn`. Connected: `github-account-badge` (login), `github-repos-btn`
  // ("My repositories..." → `clone-dialog` on the GitHub tab), `github-publish-btn` (repository open → `github.publish`), `github-logout-btn`. Disconnected: `github-login-btn`.
  // The status is only read at the opening (never on startup: no access to the keychain).
  import { onMount } from 'svelte';
  import { openDialog } from '$lib/dialogs/registry';
  import { runAction } from '$lib/actions/registry';
  import { activeSession } from '$lib/stores/session.svelte';
  import { github } from '$lib/stores/github.svelte';
  import { t } from '$i18n/index';

  let { close }: { close: () => void } = $props();

  onMount(() => {
    void github.ensureLoaded();
  });

  function login(): void {
    close();
    void openDialog('github-login-dialog');
  }

  function repos(): void {
    close();
    void openDialog('clone-dialog', { tab: 'github' });
  }

  function publish(): void {
    close();
    void runAction('github.publish');
  }

  async function logout(): Promise<void> {
    close();
    await github.logout();
  }
</script>

<div class="menu" data-testid="github-menu" role="menu" aria-label={t('github.menu.label')}>
  {#if github.status === null}
    <p class="muted info">{t('github.menu.loading')}</p>
  {:else if github.loggedIn}
    <div class="account">
      <span class="muted">{t('github.menu.loggedAs')}</span>
      <span class="badge" data-testid="github-account-badge">{github.login ?? ''}</span>
    </div>
    <button type="button" role="menuitem" class="item" data-testid="github-repos-btn" onclick={repos}>{t('github.menu.repos')}</button>
    {#if activeSession.current.repoId !== null}
      <button type="button" role="menuitem" class="item" data-testid="github-publish-btn" onclick={publish}>{t('github.publish.action')}</button>
    {/if}
    <div class="sep" role="separator"></div>
    <button type="button" role="menuitem" class="item" data-testid="github-logout-btn" onclick={() => void logout()}>{t('github.menu.logout')}</button>
  {:else}
    <p class="muted info">{t('github.menu.loggedOut')}</p>
    <button type="button" role="menuitem" class="item" data-testid="github-login-btn" onclick={login}>{t('github.menu.login')}</button>
  {/if}
</div>

<style>
  .menu {
    min-width: 220px;
    padding: 4px;
  }
  .info {
    margin: 0;
    padding: 6px 10px;
  }
  .account {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 10px 8px;
    font-size: 12px;
  }
  .badge {
    font-size: 13px;
    font-weight: 600;
    color: var(--fg);
  }
  .item {
    display: block;
    width: 100%;
    padding: 6px 10px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    text-align: left;
  }
  .item:hover,
  .item:focus-visible {
    background: var(--row-hover);
  }
  .sep {
    height: 1px;
    margin: 4px 0;
    background: var(--border);
  }
</style>
