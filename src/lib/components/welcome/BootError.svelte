<script lang="ts">
  // The backend does not respond to `app_info` (development bridge stopped...). Never displayed in the normal Tauri app.
  import type { AppError } from '$lib/ipc/types';
  import { t } from '$i18n/index';

  let { error, retry }: { error: AppError; retry: () => void } = $props();
</script>

<main class="screen">
  <div class="card" data-testid="boot-error" role="alert">
    <h1>{t('app.bootError.title')}</h1>
    <p>{error.message}</p>
    <p class="muted">{t('app.bootError.hint')}</p>
    <button type="button" class="btn btn-primary" onclick={retry}>{t('app.bootError.retry')}</button>
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
  }
  p {
    margin: 8px 0 16px;
  }
</style>
