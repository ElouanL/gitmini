<script lang="ts">
  // Screen blocking git absent or too old: `welcome-git-error[data-code=GIT_MISSING|GIT_TOO_OLD]`. No other action possible.
  import { app } from '$lib/stores/app.svelte';
  import { t } from '$i18n/index';

  const code = $derived(app.gitError ?? 'GIT_MISSING');
  const message = $derived(
    code === 'GIT_TOO_OLD'
      ? t('welcome.gitError.GIT_TOO_OLD', { found: app.info?.git?.version ?? '?', required: '2.30' })
      : t('welcome.gitError.GIT_MISSING'),
  );
</script>

<main class="screen">
  <div class="card" data-testid="welcome-git-error" data-code={code} role="alert">
    <h1>{message}</h1>
    <p class="muted">{t('welcome.gitError.hint')}</p>
  </div>
</main>

<style>
  .screen {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 24px;
    background: var(--bg-elev);
  }
  .card {
    max-width: 520px;
    padding: 32px;
    background: var(--bg);
    border: 1px solid var(--danger);
    border-radius: var(--radius);
  }
  h1 {
    font-size: 18px;
    color: var(--danger);
  }
  p {
    margin: 8px 0 0;
  }
</style>
