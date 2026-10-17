<script lang="ts" module>
  // The panels swap in place of each other, so the tab that was used is a new element: focus it again once it exists.
  let refocus = false;
</script>

<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { ui } = captureStores();
  // Tabs shared by the two recovery drawers, `reflog-panel` and `discard-trash-panel`. Selecting a tab opens the other
  // drawer in place of this one; ArrowLeft / ArrowRight / Home / End move between the tabs, as in a tablist.
  import { onMount, tick } from 'svelte';
  import { t } from '$i18n/index';
  import Icon from '$lib/components/ui/Icon.svelte';

  let { active, close, closeTestid, closeLabel }: {
    active: 'reflog-panel' | 'discard-trash-panel';
    close: () => void;
    closeTestid: string;
    closeLabel: string;
  } = $props();

  const tabs = [
    { id: 'reflog-panel', label: () => t('trash.tab.reflog'), title: () => t('reflog.title'), testid: 'recovery-tab-reflog' },
    { id: 'discard-trash-panel', label: () => t('trash.tab.discarded'), title: () => t('trash.title'), testid: 'recovery-tab-discarded' },
  ] as const;

  let root = $state<HTMLElement>();

  onMount(() => {
    if (!refocus) return;
    refocus = false;
    void tick().then(() => root?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus());
  });

  function select(id: (typeof tabs)[number]['id']): void {
    if (id === active) return;
    refocus = true;
    ui.openDrawer(id);
  }

  function onkeydown(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const at = tabs.findIndex((tab) => tab.id === active);
    let next = -1;
    if (e.key === 'ArrowRight') next = (at + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (at - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    select(tabs[next]!.id);
  }
</script>

<div class="bar">
  <div class="tabs" role="tablist" aria-label={t('trash.tabs.label')} tabindex="-1" bind:this={root} {onkeydown}>
    {#each tabs as tab (tab.id)}
      <button
        type="button"
        role="tab"
        class="tab"
        id={tab.testid}
        aria-controls="recovery-panel"
        title={tab.title()}
        aria-selected={tab.id === active}
        tabindex={tab.id === active ? 0 : -1}
        data-testid={tab.testid}
        onclick={() => select(tab.id)}
      >{tab.label()}</button>
    {/each}
  </div>
  <button type="button" class="icon-btn" data-testid={closeTestid} aria-label={closeLabel} title={closeLabel} onclick={close}>
    <Icon name="x" size={14} />
  </button>
</div>

<style>
  .bar {
    flex: none;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 8px;
    padding: 4px 8px 0;
    border-bottom: 1px solid var(--border);
  }
  .bar .icon-btn {
    margin-bottom: 2px;
  }
  .tabs {
    display: flex;
    gap: 2px;
  }
  .tab {
    height: 26px;
    padding: 0 12px;
    border: 1px solid transparent;
    border-bottom: 0;
    border-radius: var(--radius-sm) var(--radius-sm) 0 0;
    background: transparent;
    font-size: 12px;
  }
  .tab:hover {
    background: var(--row-hover);
  }
  .tab[aria-selected='true'] {
    border-color: var(--border);
    background: var(--bg-elev);
    font-weight: 600;
    margin-bottom: -1px;
  }
</style>
