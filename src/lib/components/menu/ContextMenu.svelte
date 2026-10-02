<script lang="ts">
  // A single contextual menu component, rendered in DOM, positioned on the cursor and forced to the window (03 "Context Menus").
  // `context-menu[data-menu=…]`, `context-menu-item-<action>` entries. The entries come from the registry (src/lib/menus/registry.ts).
  import { tick } from 'svelte';
  import { ui } from '$lib/stores/ui.svelte';
  import { closeContextMenu, resolveMenu } from '$lib/menus/registry';
  import { t } from '$i18n/index';
  import MenuList, { type MenuListItem } from './MenuList.svelte';

  const open = $derived(ui.contextMenu);
  const items = $derived.by<MenuListItem[]>(() => {
    const m = ui.contextMenu;
    if (!m) return [];
    return resolveMenu(m.target).map((it) => ({
      key: it.id,
      label: it.label,
      testid: `context-menu-item-${it.id}`,
      disabled: it.disabled,
      danger: it.danger,
      separatorBefore: it.separatorBefore,
      onselect: () => {
        // Close first (the return of the focus must not overwrite that of an open dialogue by the action).
        closeContextMenu();
        void it.run();
      },
    }));
  });

  let wrapper = $state<HTMLDivElement | null>(null);
  let pos = $state({ x: 0, y: 0 });

  // Position: on the cursor, then re-traced to stay in the window.
  $effect(() => {
    const m = ui.contextMenu;
    if (!m) return;
    pos = { x: m.x, y: m.y };
    void tick().then(() => {
      if (!wrapper) return;
      const r = wrapper.getBoundingClientRect();
      const x = Math.max(4, Math.min(m.x, window.innerWidth - r.width - 4));
      const y = Math.max(4, Math.min(m.y, window.innerHeight - r.height - 4));
      pos = { x, y };
    });
  });

  function onWindowPointerDown(e: PointerEvent): void {
    if (ui.contextMenu && wrapper && !wrapper.contains(e.target as Node)) closeContextMenu();
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} onblur={() => closeContextMenu()} onresize={() => closeContextMenu()} />

{#if open}
  <div bind:this={wrapper} class="wrapper" style:left="{pos.x}px" style:top="{pos.y}px">
    <MenuList {items} testid="context-menu" attrs={{ 'data-menu': open.target.menu }} label={t('menu.label')} onclose={closeContextMenu} />
  </div>
{/if}

<style>
  .wrapper {
    position: fixed;
    z-index: var(--z-menu);
  }
</style>
