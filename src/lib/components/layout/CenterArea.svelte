<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { ui } = captureStores();
  // Central zone (03): the graph, or a view that replaced it (`diff-viewer`); `Escape` / `diff-close-btn` returns to the graph.
  // The graph remains mounted (masked) under the view: scroll position and selection are kept.
  import { getCenterView, getDrawer } from '$lib/panels/registry';

  import LazyView from '../ui/LazyView.svelte';

  const graph = $derived(getCenterView('graph'));
  const other = $derived(ui.centerIsGraph ? undefined : getCenterView(ui.centerView.id));
  const drawer = $derived(ui.drawer ? getDrawer(ui.drawer) : undefined);
</script>

<div class="center">
  <div class="layer" class:hidden={!ui.centerIsGraph} inert={!ui.centerIsGraph}>
    <LazyView entry={graph} placeholderTestid="graph-placeholder" />
  </div>
  {#if !ui.centerIsGraph}
    <div class="layer top">
      <LazyView entry={other} props={ui.centerView.props} placeholderTestid="{ui.centerView.id}-placeholder" />
    </div>
  {/if}
  {#if ui.drawer}
    <aside class="drawer" data-zone-drawer>
      <LazyView entry={drawer} props={{ close: () => ui.closeDrawer() }} placeholderTestid={ui.drawer} />
    </aside>
  {/if}
</div>

<style>
  .center {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .layer {
    position: absolute;
    inset: 0;
    min-width: 0;
    background: var(--bg);
  }
  .layer.hidden {
    visibility: hidden;
  }
  .layer.top {
    z-index: 2;
  }
  .drawer {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: var(--z-drawer);
    width: min(360px, 60%);
    border-left: 1px solid var(--border);
    background: var(--bg-elev);
    box-shadow: var(--shadow);
  }
</style>
