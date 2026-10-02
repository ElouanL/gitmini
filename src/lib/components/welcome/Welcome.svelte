<script lang="ts">
  // Home screen (no repository open): `welcome-open-btn`, `welcome-clone-btn`, `welcome-recent-list` / `-item`,
  // `welcome-github-login-btn`, `welcome-open-error[data-code][data-reason]`.
  import { runAction } from '$lib/actions/registry';
  import { featureFlags } from '$lib/feature-flags';
  import { copyText } from '$lib/clipboard';
  import { repo } from '$lib/stores/repo.svelte';
  import { t } from '$i18n/index';
  import Icon from '../ui/Icon.svelte';
  import Logo from '../ui/Logo.svelte';

  const err = $derived(repo.openError);

  const errorText = $derived.by(() => {
    if (!err) return '';
    if (err.code === 'NOT_A_REPO') {
      if (err.reason === 'bare') return t('welcome.error.NOT_A_REPO.bare');
      if (err.reason === 'dubious-ownership') return t('welcome.error.NOT_A_REPO.dubious-ownership');
      return t('welcome.error.NOT_A_REPO');
    }
    if (err.code === 'UNSUPPORTED_REPO_FORMAT') {
      const x = typeof err.details.extension === 'string' ? `extension ${err.details.extension}` : null;
      const label = err.reason === 'sha256' ? 'SHA-256' : err.reason === 'reftable' ? 'reftable' : (x ?? 'extension');
      return t('welcome.error.UNSUPPORTED_REPO_FORMAT', { reason: label });
    }
    if (err.code === 'NOT_FOUND') return t('welcome.error.NOT_FOUND', { path: err.path });
    return err.message;
  });

  const safeDirCommand = $derived(err ? `git config --global --add safe.directory ${err.path}` : '');
</script>

<main class="welcome" data-testid="welcome">
  <div class="card">
    <div class="brand">
      <Logo size={44} />
      <h1>{t('welcome.title')}</h1>
    </div>
    <p class="muted">{t('welcome.subtitle')}</p>

    <div class="actions">
      <button type="button" class="btn btn-primary" data-testid="welcome-open-btn" disabled={repo.opening} onclick={() => void runAction('repo.open')}>
        <Icon name="folder" /> {t('welcome.open')}
      </button>
      <button type="button" class="btn" data-testid="welcome-clone-btn" onclick={() => void runAction('repo.clone')}>
        {t('welcome.clone')}
      </button>
      {#if featureFlags.githubLogin}
        <button type="button" class="btn" data-testid="welcome-github-login-btn" onclick={() => void runAction('github.login')}>
          <Icon name="user" /> {t('welcome.github')}
        </button>
      {/if}
    </div>

    {#if err}
      <div class="error" data-testid="welcome-open-error" data-code={err.code} data-reason={err.reason ?? undefined} role="alert">
        <p>{errorText}</p>
        {#if err.reason === 'dubious-ownership'}
          <div class="cmd">
            <code>{safeDirCommand}</code>
            <button type="button" class="btn" onclick={() => void copyText(safeDirCommand)}>{t('welcome.error.copyCommand')}</button>
          </div>
        {/if}
      </div>
    {/if}

    <h2>{t('welcome.recent')}</h2>
    <ul class="recent" data-testid="welcome-recent-list">
      {#each repo.recents.slice(0, 10) as r (r.path)}
        <li>
          <button type="button" class="recent-item" data-testid="welcome-recent-item" data-path={r.path} disabled={repo.opening} onclick={() => void repo.open(r.path)}>
            <span class="name">{r.name}</span>
            <span class="path muted truncate">{r.path}</span>
          </button>
        </li>
      {:else}
        <li class="empty muted">{t('welcome.recentEmpty')}</li>
      {/each}
    </ul>
  </div>
</main>

<style>
  .welcome {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 24px;
    background: var(--bg-elev);
    overflow: auto;
  }
  .card {
    width: min(560px, 100%);
    padding: 32px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  h1 {
    font-size: 28px;
  }
  h2 {
    margin: 24px 0 8px;
    font-size: 12px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fg-muted);
  }
  .card > p {
    margin: 4px 0 20px;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .error {
    margin-top: 16px;
    padding: 10px 12px;
    border: 1px solid var(--danger);
    border-radius: var(--radius-sm);
    color: var(--danger);
  }
  .error p {
    margin: 0;
  }
  .cmd {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    color: var(--fg);
  }
  .cmd code {
    flex: 1;
    padding: 4px 6px;
    background: var(--bg-sunken);
    border-radius: var(--radius-sm);
    overflow-wrap: anywhere;
  }
  .recent {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .recent-item {
    display: flex;
    align-items: baseline;
    gap: 12px;
    width: 100%;
    height: 34px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    text-align: left;
  }
  .recent-item:hover:not(:disabled) {
    background: var(--row-hover);
  }
  .name {
    font-weight: 600;
  }
  .path {
    flex: 1;
    min-width: 0;
    font-size: 12px;
  }
  .empty {
    padding: 4px 10px;
  }
</style>
