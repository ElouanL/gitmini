<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { op, repo } = captureStores();
  // Operation Banner UNIQUE (03): `op-banner[data-kind][data-phase][data-stop-reason]`, `op-banner-progress`,
  // `op-banner-continue-btn`, `op-banner-skip-btn`, `op-banner-abort-btn`. Visible until `RepoOpState` is `null`.
  import { runAction } from '$lib/actions/registry';

  import { t } from '$i18n/index';
  import { bannerButtons, bannerLabel } from './label';

  const st = $derived(op.state);
  const buttons = $derived(st ? bannerButtons(st) : null);
  const label = $derived(st ? bannerLabel(st, repo.head?.branch ?? null) : '');
  const running = $derived(st?.phase === 'running' || op.busy);
  const unresolved = $derived((st?.conflictedPaths.length ?? 0) > 0);
  const inflightReason = $derived(op.blockReason('control'));

  const run = (id: string): void => void runAction(id);
</script>

{#if st && buttons}
  <div
    class="banner"
    data-testid="op-banner"
    data-kind={st.kind}
    data-phase={st.phase}
    data-stop-reason={st.phase === 'stopped' ? (st.stopReason ?? undefined) : undefined}
    role="status"
  >
    <span class="dot" aria-hidden="true"></span>
    <span class="text" data-testid="op-banner-progress">{label}</span>
    <span class="spacer"></span>
    {#if buttons.continue}
      <button
        type="button"
        class="btn btn-primary"
        data-testid="op-banner-continue-btn"
        disabled={running || unresolved}
        title={unresolved ? t('banner.continue.disabled') : (inflightReason ?? undefined)}
        onclick={() => run('op.continue')}
      >
        {st.kind === 'merge' ? t('banner.continue.merge') : t('banner.continue')}
      </button>
    {/if}
    {#if buttons.skip}
      <button type="button" class="btn" data-testid="op-banner-skip-btn" disabled={running} title={inflightReason ?? undefined} onclick={() => run('op.skip')}>
        {t('banner.skip')}
      </button>
    {/if}
    {#if buttons.abort}
      <button type="button" class="btn btn-danger" data-testid="op-banner-abort-btn" disabled={running} title={inflightReason ?? undefined} onclick={() => run('op.abort')}>
        {t('banner.abort')}
      </button>
    {/if}
  </div>
{/if}

<style>
  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 40px;
    padding: 6px 12px;
    background: var(--bg-elev);
    border-bottom: 1px solid var(--border);
    border-left: 4px solid var(--warn);
    z-index: var(--z-banner);
  }
  .banner[data-phase='conflict'] {
    border-left-color: var(--danger);
  }
  .banner[data-phase='running'] {
    border-left-color: var(--accent);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--warn);
    flex: none;
  }
  .banner[data-phase='conflict'] .dot {
    background: var(--danger);
  }
  .banner[data-phase='running'] .dot {
    background: var(--accent);
  }
  .text {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .spacer {
    flex: 1;
  }
</style>
