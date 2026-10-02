<script lang="ts">
  // `repo-missing-screen`: repository folder has disappeared (03). Replaces sidebar, graph and right panel.
  import { repo } from '$lib/stores/repo.svelte';
  import { t } from '$i18n/index';
</script>

<main class="screen">
  <div class="card" data-testid="repo-missing-screen" role="alert">
    <h1>{t('missing.message', { path: repo.info?.workdir ?? '' })}</h1>
    <p class="muted">{t('missing.hint')}</p>
    <button type="button" class="btn btn-primary" data-testid="repo-missing-screen-close-btn" onclick={() => void repo.closeMissing()}>
      {t('missing.close')}
    </button>
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
    max-width: 560px;
    padding: 32px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
  }
  h1 {
    font-size: 17px;
    overflow-wrap: anywhere;
  }
  p {
    margin: 8px 0 20px;
  }
</style>
