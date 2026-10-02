<script lang="ts">
  // Reserved space of a panel or view that no domain has (yet) saved. Ports the expected `data-testid`.
  import { t } from '$i18n/index';

  let { testid, message }: { testid: string; message?: string } = $props();
</script>

<div class="placeholder" data-testid={testid} data-placeholder="true">
  <span class="muted">{message ?? t('panel.placeholder', { id: testid })}</span>
</div>

<style>
  .placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 16px;
    text-align: center;
  }
</style>
