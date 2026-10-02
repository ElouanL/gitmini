<script lang="ts">
  // Resizeable splitter (Pointer Events, no HTML5 DnD): `layout-splitter-left` / `layout-splitter-right`.
  // Double-click: default width; ←/→: ±16 px on the keyboard.
  import { app } from '$lib/stores/app.svelte';
  import { DEFAULT_LAYOUT, LAYOUT_LIMITS } from '$lib/ipc/settings-types';
  import { t } from '$i18n/index';

  let { side }: { side: 'left' | 'right' } = $props();

  const key = $derived(side);
  const [min, max] = $derived(LAYOUT_LIMITS[side]);
  const width = $derived(app.layout[side]);

  let startX = 0;
  let startWidth = 0;
  let dragging = $state(false);

  const clamp = (v: number) => Math.round(Math.max(min, Math.min(max, v)));
  const commit = (w: number) => void app.set('layout', { ...app.layout, [key]: clamp(w) });

  function onpointerdown(e: PointerEvent): void {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragging = true;
    startX = e.clientX;
    startWidth = width;
    e.preventDefault();
  }

  function onpointermove(e: PointerEvent): void {
    if (!dragging) return;
    // Left: the side bar grows to the right; right: the sign grows to the left.
    const dx = e.clientX - startX;
    commit(side === 'left' ? startWidth + dx : startWidth - dx);
  }

  function onpointerup(e: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  }

  function onkeydown(e: KeyboardEvent): void {
    const step = e.shiftKey ? 48 : 16;
    const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft';
    const shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight';
    if (e.key === grow) commit(width + step);
    else if (e.key === shrink) commit(width - step);
    else return;
    e.preventDefault();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="splitter"
  class:dragging
  role="separator"
  aria-orientation="vertical"
  aria-label={t(side === 'left' ? 'layout.splitterLeft' : 'layout.splitterRight')}
  aria-valuemin={min}
  aria-valuemax={max}
  aria-valuenow={width}
  tabindex="0"
  data-testid="layout-splitter-{side}"
  {onpointerdown}
  {onpointermove}
  {onpointerup}
  onpointercancel={onpointerup}
  ondblclick={() => commit(DEFAULT_LAYOUT[side])}
  {onkeydown}
></div>

<style>
  .splitter {
    position: relative;
    flex: none;
    width: 5px;
    margin: 0 -2px;
    z-index: 5;
    cursor: col-resize;
    touch-action: none;
    background: transparent;
  }
  .splitter::after {
    content: '';
    position: absolute;
    inset: 0 2px;
    background: var(--border);
  }
  .splitter:hover::after,
  .splitter.dragging::after,
  .splitter:focus-visible::after {
    background: var(--accent);
    inset: 0 1px;
  }
  .splitter:focus-visible {
    box-shadow: none;
  }
</style>
