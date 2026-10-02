<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { graph } = captureStores();
  // repository menu after a branch drag and drop: `graph-drop-menu` with `graph-drop-menu-item-{rebase,merge,cancel}`.
  // Rebase / Merge delegate to `drag.rebase` / `drag.merge` actions of the registry (flows domain): until they are
  // The input is greyed and only "Cancel" acts. During the action, `graph.dragDrop` carries { src, dst } (see src/README.md).
  import { tick } from 'svelte';
  import { actionContext, actionDisabledReason, getAction, runAction } from '$lib/actions/registry';

  import { t } from '$i18n/index';
  import { dnd } from './dnd.svelte';

  const menu = $derived(dnd.menu);
  let el = $state<HTMLDivElement>();

  function unavailable(id: string): string | null {
    const def = getAction(id);
    if (!def) return t('graph.drop.unavailable');
    return actionDisabledReason(def, actionContext()) ?? null;
  }

  async function run(id: 'drag.rebase' | 'drag.merge'): Promise<void> {
    const m = dnd.menu;
    if (!m) return;
    dnd.close();
    graph.dragDrop = { src: m.src, dst: m.dst };
    try {
      await runAction(id);
    } finally {
      graph.dragDrop = null;
    }
  }

  function items(): HTMLButtonElement[] {
    return el ? [...el.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')] : [];
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      dnd.close();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Tab') return;
    const list = items();
    if (list.length === 0) return;
    e.preventDefault();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const dir = e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey) ? -1 : 1;
    list[(i + dir + list.length) % list.length]!.focus();
  }

  // Open: focus on the first active entry (Enter valid, Escape cancels everything); click elsewhere = Cancel.
  $effect(() => {
    if (!menu) return;
    void tick().then(() => items()[0]?.focus());
    const onDown = (e: PointerEvent): void => {
      if (!(e.target instanceof Node) || !el?.contains(e.target)) dnd.close();
    };
    window.addEventListener('keydown', onKeydown, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKeydown, true);
      window.removeEventListener('pointerdown', onDown, true);
    };
  });

  const left = $derived(menu ? Math.max(4, Math.min(menu.x, window.innerWidth - 300)) : 0);
  const top = $derived(menu ? Math.max(4, Math.min(menu.y, window.innerHeight - 140)) : 0);
</script>

{#if menu}
  {@const rebaseOff = unavailable('drag.rebase')}
  {@const mergeOff = unavailable('drag.merge')}
  <div bind:this={el} class="gr-drop-menu" data-testid="graph-drop-menu" role="menu" style:left="{left}px" style:top="{top}px">
    {#if menu.options.rebase}
      <button type="button" role="menuitem" data-testid="graph-drop-menu-item-rebase" disabled={rebaseOff !== null} title={rebaseOff ?? undefined} onclick={() => void run('drag.rebase')}>
        {t('graph.drop.rebase', { src: menu.src.name, dst: menu.dst.name })}
      </button>
    {/if}
    {#if menu.options.merge}
      <button type="button" role="menuitem" data-testid="graph-drop-menu-item-merge" disabled={mergeOff !== null} title={mergeOff ?? undefined} onclick={() => void run('drag.merge')}>
        {t('graph.drop.merge', { src: menu.src.name, dst: menu.dst.name })}
      </button>
    {/if}
    {#if menu.options.none}
      <div class="gr-drop-empty" data-testid="graph-drop-menu-empty">{t('graph.drop.empty')}</div>
    {/if}
    <button type="button" role="menuitem" data-testid="graph-drop-menu-item-cancel" onclick={() => dnd.close()}>{t('graph.drop.cancel')}</button>
  </div>
{/if}
