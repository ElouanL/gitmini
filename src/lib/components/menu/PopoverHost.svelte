<script lang="ts">
  // Hosts the open popover (`ui.popover`) under its anchor button. Closing: external click, Escape (global).
  import { tick } from 'svelte';
  import { getPopover } from '$lib/popovers/registry';
  import { ui } from '$lib/stores/ui.svelte';
  import { t } from '$i18n/index';
  import LazyView from '../ui/LazyView.svelte';

  const open = $derived(ui.popover);
  const entry = $derived(open ? getPopover(open.id) : undefined);

  let el = $state<HTMLDivElement | null>(null);
  let pos = $state({ left: 0, top: 0 });

  $effect(() => {
    const p = ui.popover;
    if (!p) return;
    const r = p.anchor.getBoundingClientRect();
    pos = { left: r.left, top: r.bottom + 4 };
    void tick().then(() => {
      if (!el) return;
      const w = el.getBoundingClientRect().width;
      pos = { left: Math.max(4, Math.min(r.left, window.innerWidth - w - 4)), top: r.bottom + 4 };
    });
  });

  function onWindowPointerDown(e: PointerEvent): void {
    const p = ui.popover;
    if (!p) return;
    const target = e.target as Node;
    if (el?.contains(target) || p.anchor.contains(target)) return;
    ui.popover = null;
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

{#if open}
  <div bind:this={el} class="popover" style:left="{pos.left}px" style:top="{pos.top}px">
    {#if entry}
      <LazyView {entry} props={{ ...open.props, close: () => ui.closePopover() }} placeholderTestid="popover-missing" />
    {:else}
      <div class="missing" data-testid="popover-missing">{t('panel.placeholder', { id: open.id })}</div>
    {/if}
  </div>
{/if}

<style>
  .popover {
    position: fixed;
    z-index: var(--z-menu);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
  }
  .missing {
    padding: 12px 16px;
    color: var(--fg-muted);
  }
</style>
