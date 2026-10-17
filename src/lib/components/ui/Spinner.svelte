<script lang="ts">
  import { t } from '$i18n/index';

  let { size = 14 }: { size?: number } = $props();
</script>

<span class="spinner" style:width="{size}px" style:height="{size}px" role="progressbar" aria-label={t('app.spinner')}></span>

<style>
  .spinner {
    display: inline-block;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
