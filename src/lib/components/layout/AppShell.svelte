<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { graph, ui } = captureStores();
  // 3 panel window (03): toolbar (44 px), sidebar (240 px, 180–400), central area, right panel (360 px, 280–600).
  // `layout-splitter-left` / `layout-splitter-right` separators, widths persisted in the global `layout` setting.
  // Under 1200 px wide, the right panel folds and opens par-dessus the graph at selection.
  import { onMount } from 'svelte';
  import { app } from '$lib/stores/app.svelte';

  import { updateCommitGraphHint } from '$lib/stores/wiring';
  import { t } from '$i18n/index';
  import OpBanner from '../banner/OpBanner.svelte';
  import Sidebar from '../sidebar/Sidebar.svelte';
  import Toolbar from '../toolbar/Toolbar.svelte';
  import Icon from '../ui/Icon.svelte';
  import CenterArea from './CenterArea.svelte';
  import HintBanners from './HintBanners.svelte';
  import RightPanel from './RightPanel.svelte';
  import Splitter from './Splitter.svelte';

  const layout = $derived(app.layout);

  // Close window: the right panel becomes a superimposed shutter.
  onMount(() => {
    if (typeof matchMedia !== 'function') return;
    const mql = matchMedia('(max-width: 1199px)');
    const apply = () => {
      ui.narrow = mql.matches;
      if (!mql.matches) ui.rightOverlayOpen = false;
    };
    apply();
    mql.addEventListener('change', apply);
    return () => mql.removeEventListener('change', apply);
  });

  // The selection opens the shutter in narrow mode.
  $effect(() => {
    if (ui.narrow && graph.selection.kind !== 'none') ui.rightOverlayOpen = true;
  });

  // commit-graph Tip: More than 50,000 commits without commit-graph.
  $effect(() => {
    void graph.total;
    updateCommitGraphHint();
  });

  const showLeft = $derived(!layout.leftCollapsed);
  const dockRight = $derived(!ui.narrow && !layout.rightCollapsed);
  const overlayRight = $derived(ui.narrow && ui.rightOverlayOpen);
</script>

<div class="shell" data-testid="layout" style:--left-w="{layout.left}px" style:--right-w="{layout.right}px">
  <Toolbar />
  <div class="body">
    {#if showLeft}
      <aside class="left" data-zone="sidebar" data-testid="layout-left" tabindex="-1">
        <Sidebar />
      </aside>
      <Splitter side="left" />
    {/if}

    <main class="center" data-zone="graph" data-testid="layout-center" tabindex="-1">
      <OpBanner />
      <HintBanners />
      <CenterArea />
    </main>

    {#if dockRight}
      <Splitter side="right" />
      <aside class="right" data-zone="right" data-testid="layout-right" tabindex="-1">
        <RightPanel />
      </aside>
    {/if}
    {#if overlayRight}
      <aside class="right overlay" data-zone="right" data-testid="layout-right" tabindex="-1">
        <button type="button" class="icon-btn close" data-testid="layout-right-close-btn" aria-label={t('layout.closeRight')} title={t('layout.closeRight')} onclick={() => (ui.rightOverlayOpen = false)}>
          <Icon name="x" size={14} />
        </button>
        <RightPanel />
      </aside>
    {/if}
  </div>
</div>

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 960px;
    min-height: 0;
    background: var(--bg);
  }
  .body {
    position: relative;
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .left {
    flex: none;
    width: var(--left-w);
    min-width: 0;
    overflow: hidden;
    border-right: 1px solid var(--border);
  }
  .center {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .right {
    flex: none;
    width: var(--right-w);
    min-width: 0;
    overflow: hidden;
    border-left: 1px solid var(--border);
  }
  .right.overlay {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: var(--z-drawer);
    box-shadow: var(--shadow);
    background: var(--bg);
  }
  .close {
    position: absolute;
    top: 6px;
    right: 6px;
    z-index: 1;
  }
</style>
