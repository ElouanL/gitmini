<script lang="ts">
  // `empty-panel`: Nothing is selected (03 "Right hand panel").
  import { t } from '$i18n/index';
</script>

<div class="empty" data-testid="empty-panel">
  <p class="title">{t('panel.empty')}</p>
  <p class="muted">{t('panel.empty.hint')}</p>
</div>

<style>
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    height: 100%;
    padding: 24px;
    text-align: center;
  }
  .title {
    margin: 0;
    font-weight: 600;
  }
  p {
    margin: 0;
  }
</style>
