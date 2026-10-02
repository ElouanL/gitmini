<script lang="ts">
  import { tick } from 'svelte';
  import { runAction } from '$lib/actions/registry';
  import { repo } from '$lib/stores/repo.svelte';
  import { opFor } from '$lib/stores/op.svelte';
  import { activeSession, type Session } from '$lib/stores/session.svelte';
  import { t } from '$i18n/index';
  import Icon from '../ui/Icon.svelte';
  import MenuList, { type MenuListItem } from '../menu/MenuList.svelte';

  let root: HTMLElement;
  let addButton: HTMLButtonElement;
  let menuOpen = $state(false);
  let menuPosition = $state({ left: 8, top: 36 });
  const active = $derived(activeSession.current);
  const items = $derived.by<MenuListItem[]>(() => [
    ...repo.recents.map((recent) => ({
      key: recent.path, label: recent.name, hint: recent.path, testid: 'repo-tabs-recent-item',
      disabled: repo.opening,
      onselect: () => { menuOpen = false; void repo.open(recent.path); },
    })),
    { key: 'open', label: t('toolbar.openRepo'), testid: 'repo-tabs-open-btn', separatorBefore: repo.recents.length > 0,
      disabled: repo.opening, onselect: () => { menuOpen = false; void runAction('repo.open'); } },
    { key: 'clone', label: t('toolbar.cloneRepo'), testid: 'repo-tabs-clone-btn',
      onselect: () => { menuOpen = false; void runAction('repo.clone'); } },
  ]);

  $effect(() => {
    const id = active.repoId;
    void tick().then(() => root?.querySelector<HTMLElement>(`[data-repo-id="${id}"][role="tab"]`)
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }));
  });

  async function select(owner: Session): Promise<void> {
    if (!repo.activate(owner)) return;
    await tick();
    root.querySelector<HTMLElement>(`[data-repo-id="${owner.repoId}"][role="tab"]`)?.focus({ preventScroll: true });
  }

  function onkey(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    if (target.getAttribute('role') !== 'tab') return;
    const i = repo.tabs.indexOf(active);
    let next: number;
    if (event.key === 'ArrowRight') next = (i + 1) % repo.tabs.length;
    else if (event.key === 'ArrowLeft') next = (i - 1 + repo.tabs.length) % repo.tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = repo.tabs.length - 1;
    else return;
    event.preventDefault();
    void select(repo.tabs[next]!);
  }

  function toggleMenu(): void {
    const rect = addButton.getBoundingClientRect();
    menuPosition = { left: Math.max(8, Math.min(rect.left, window.innerWidth - 328)), top: rect.bottom };
    menuOpen = !menuOpen;
  }

  async function close(owner: Session): Promise<void> {
    await repo.close(owner);
    await tick();
    root.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
  }

  function closeMenu(refocus = true): void {
    menuOpen = false;
    if (refocus) addButton?.focus();
  }
</script>

<svelte:window onpointerdown={(event) => {
  if (!(event.target as Element)?.closest('[data-repo-tabs-add]')) closeMenu(false);
}} onkeydown={(event) => {
  if (menuOpen && event.key === 'Escape') { event.preventDefault(); closeMenu(); }
}} />

<header class="tabs-bar" data-testid="repo-tabs" bind:this={root}>
  <div class="tabs" role="tablist" tabindex="-1" aria-label={t('tabs.label')} onkeydown={onkey}>
    {#each repo.tabs as owner (owner)}
      {@const operation = opFor(owner).inflight}
      <div class="tab" class:active={owner === active} role="presentation">
        <button type="button" role="tab" class="select" id={`repo-tab-${owner.repoId}`}
          data-testid="repo-tab" data-repo-id={owner.repoId} data-path={owner.info?.workdir}
          aria-selected={owner === active} aria-controls="repo-panel" tabindex={owner === active ? 0 : -1}
          title={owner.info?.workdir} onclick={() => void select(owner)}>
          <Icon name="branch" size={13} />
          <span class="name">{owner.info?.name}</span>
          {#if operation}
            <span class="activity" data-testid="repo-tab-progress" title={operation.progressLabel ?? operation.label}>
              {operation.percent !== null ? `${Math.round(operation.percent)} %` : '…'}
            </span>
          {:else if owner.attention || owner.missing}
            <span class="attention" data-testid="repo-tab-attention" aria-label={t('tabs.attention')}>•</span>
          {/if}
        </button>
        <button type="button" class="close" data-testid="repo-tab-close-btn" data-repo-id={owner.repoId}
          disabled={operation !== null || repo.opening} aria-label={t('tabs.close', { name: owner.info?.name ?? '' })}
          title={repo.opening ? t('app.loading') : operation ? t('tabs.busy') : t('tabs.close', { name: owner.info?.name ?? '' })}
          onclick={() => void close(owner)}><Icon name="x" size={12} /></button>
      </div>
    {/each}
  </div>
  <div class="add" data-repo-tabs-add>
    <button type="button" class="add-button" data-testid="repo-tabs-add-btn" bind:this={addButton}
      aria-label={t('tabs.add')} title={t('tabs.add')} aria-haspopup="menu" aria-expanded={menuOpen}
      onclick={toggleMenu}><Icon name="plus" size={17} /></button>
    {#if menuOpen}
      <div class="menu-panel" style:left="{menuPosition.left}px" style:top="{menuPosition.top}px">
        <MenuList {items} testid="repo-tabs-menu" label={t('tabs.add')} onclose={() => closeMenu()} />
      </div>
    {/if}
  </div>
</header>

<style>
  .tabs-bar { display: flex; flex: none; height: 36px; align-items: stretch; background: var(--bg-elev); border-bottom: 1px solid var(--border); }
  .tabs { display: flex; min-width: 0; overflow-x: auto; scrollbar-width: thin; }
  .tab { display: flex; flex: none; align-items: center; max-width: 250px; border-right: 1px solid var(--border); border-top: 2px solid transparent; color: var(--fg-muted); }
  .tab.active { color: var(--fg); background: var(--bg); border-top-color: var(--accent); }
  .tab:hover { background: var(--row-hover); }
  .select { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 0 8px 0 14px; height: 100%; background: transparent; color: inherit; border: 0; cursor: pointer; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  .close, .add-button { display: grid; place-items: center; flex: none; border: 0; background: transparent; color: var(--fg-muted); cursor: pointer; }
  .close { width: 26px; height: 26px; margin-right: 5px; border-radius: 4px; }
  .close:hover, .add-button:hover { background: var(--row-selected); color: var(--fg); }
  .close:disabled { opacity: .35; cursor: default; }
  .activity { font: 11px var(--font-mono); color: var(--accent); white-space: nowrap; }
  .attention { color: var(--warn); font-size: 18px; }
  .add { position: relative; flex: none; }
  .add-button { width: 38px; height: 100%; }
  .menu-panel { position: fixed; z-index: var(--z-menu); width: 320px; max-height: min(480px, 75vh); overflow-y: auto; background: var(--bg-elev); border: 1px solid var(--border); border-radius: 6px; box-shadow: var(--shadow); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
</style>
