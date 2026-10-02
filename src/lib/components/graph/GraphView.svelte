<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { graph, op, refs, repo, status } = captureStores();
  // Central view "graph" (04): search bar, column headers, virtualized scrollable viewport.
  // Structure: `graph-viewport` (native thread) > `.gr-sizer` (virtual height) > `.gr-stage` (sticky, viewport size) which
  // carries the Canvas (`graph-canvas`, Lanes + Background Bands) and the DOM Line Pool. Everything is repositioned in the SAME frame
  // (rAF) from `scrollTop`: Canvas and text never move away from each other.
  import { onMount, untrack } from 'svelte';
  import './graph.css';
  import Spinner from '../ui/Spinner.svelte';
  import { app } from '$lib/stores/app.svelte';

  import { t, tp } from '$i18n/index';
  import { GraphController } from './controller.svelte';
  import { handleClick, handleContextMenu, handleDblClick, handleKeyDown, handlePointerMove } from './interactions';
  import DropMenu from './DropMenu.svelte';
  import GraphSearch from './GraphSearch.svelte';

  const ctrl = new GraphController();

  let root: HTMLDivElement;
  let viewport: HTMLDivElement;
  let sizer: HTMLDivElement;
  let stage: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let rowsHost: HTMLDivElement;

  onMount(() => {
    ctrl.mount({ root, viewport, sizer, stage, canvas, rows: rowsHost });
    return () => ctrl.unmount();
  });

  // Reactions to shared data: each effect only marks the next frame (the drawing is out of Svelte).
  $effect(() => {
    void graph.pages;
    untrack(() => ctrl.touch());
  });
  $effect(() => {
    void graph.selection;
    untrack(() => ctrl.onSelection());
  });
  $effect(() => {
    void status.snapshot;
    untrack(() => ctrl.onStatus());
  });
  $effect(() => {
    void app.themeVersion;
    untrack(() => ctrl.onTheme());
  });
  $effect(() => {
    void app.settings;
    untrack(() => ctrl.onSettings());
  });
  $effect(() => {
    void refs.snapshot;
    untrack(() => ctrl.onRefs());
  });
  $effect(() => {
    void repo.info;
    void repo.head;
    untrack(() => ctrl.onRepo());
  });
  $effect(() => {
    void ctrl.search.matches;
    untrack(() => ctrl.onMatches());
  });
  // `graph.requestReveal(oid)`: Scroll to a commit without touching the selection.
  $effect(() => {
    const r = graph.revealRequest;
    if (r) untrack(() => void ctrl.scrollToOid(r.oid));
  });
  // "Unauthorized" Cursor on the sources to drag and drop during a write or operation to status .
  $effect(() => {
    const blocked = op.busy || op.state !== null;
    document.documentElement.toggleAttribute('data-gr-drag-blocked', blocked);
    return () => document.documentElement.removeAttribute('data-gr-drag-blocked');
  });
  // The viewport carries `data-zone-focus`: `Mod+2` gives it the focus (`graph` zone).
  const showLoading = $derived(graph.loading ? ctrl.missingVisible || graph.pages.length === 0 : ctrl.missingVisible);
</script>

<div class="gr-root" data-testid="graph" bind:this={root}>
  {#if graph.searchOpen}
    <GraphSearch {ctrl} />
  {/if}
  <div class="gr-head" aria-hidden="true">
    <span>{t('graph.col.refs')}</span>
    <span title={ctrl.hiddenLaneCount > 0 ? tp('graph.lanesHidden', ctrl.hiddenLaneCount) : undefined}>{t('graph.col.graph')}</span>
    <span>{t('graph.col.message')}</span>
    <span>{t('graph.col.author')}</span>
    <span>{t('graph.col.date')}</span>
    <span>{t('graph.col.sha')}</span>
  </div>
  <div
    class="gr-viewport"
    data-testid="graph-viewport"
    data-zone-focus
    tabindex="0"
    role="listbox"
    aria-label={t('graph.label')}
    aria-multiselectable="true"
    bind:this={viewport}
    onscroll={() => ctrl.onScroll()}
    onkeydown={(e) => handleKeyDown(ctrl, e)}
  >
    <div class="gr-sizer" bind:this={sizer}>
      <!-- The keyboard is managed by the viewport (single focus list); the mouse by delegation on the stage. -->
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div
        class="gr-stage"
        bind:this={stage}
        onclick={(e) => handleClick(ctrl, e)}
        ondblclick={handleDblClick}
        oncontextmenu={(e) => handleContextMenu(ctrl, e)}
        onpointermove={(e) => handlePointerMove(ctrl, e)}
        onpointerleave={() => ctrl.setHover(null)}
      >
        <!-- Displayed as soon as the first page has arrived: `appReady` specs (graph-canvas visible) therefore awaits the first screen. -->
        <canvas class="gr-canvas" data-testid="graph-canvas" bind:this={canvas} hidden={graph.pages.length === 0} aria-hidden="true"></canvas>
        <div class="gr-rows" bind:this={rowsHost}></div>
        <!-- Always present (attribute `hidden`): no nodes are added or removed from the viewport during scrolling. -->
        <div
          class="gr-lane-fade"
          data-testid="graph-lanes-hidden"
          hidden={ctrl.hiddenLaneCount === 0}
          data-hidden-lanes={ctrl.hiddenLaneCount}
          style:left="{ctrl.columns.graphX + ctrl.columns.graph - 24}px"
        ></div>
        {#if ctrl.empty}
          <div class="gr-empty" data-testid="graph-empty-state" style:top={ctrl.wipVisible ? '28px' : '0'}>{t('graph.empty')}</div>
        {/if}
        <div class="gr-loading" data-testid="graph-loading" role="status" hidden={!showLoading}><Spinner size={12} /><span>{t('graph.loading')}</span></div>
      </div>
    </div>
  </div>
  <DropMenu />
</div>
