<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { graph } = captureStores();
  // Right panel router (03): depending on the graph selection, makes the component recorded by the domain
  // (`registerRightPanel`, possibly loaded on request), otherwise a reserved space carrying the right `data-testid`.
  import { getRightPanel } from '$lib/panels/registry';
  import { panelIdFor } from '$lib/panels/route';

  import LazyView from '../ui/LazyView.svelte';

  const id = $derived(panelIdFor(graph.selection));
  const entry = $derived(getRightPanel(id));
</script>

<div class="right-panel">
  <LazyView {entry} placeholderTestid={id} />
</div>

<style>
  .right-panel {
    height: 100%;
    overflow: hidden;
    background: var(--bg);
  }
</style>
