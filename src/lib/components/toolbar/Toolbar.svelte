<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { reportError, graph, op, repo, status, undo, ui } = captureStores();
  // Toolbar (44 px, 03): repository, current branch, cancel/reflog, fetch/pull/push, branch, stash, search, palette, GitHub,
  // settings, progress and cancellation of a [L] command. Each button initiates a registry action (src/lib/actions).
  import { actionDisabledReason, actionContext, getAction, runAction } from '$lib/actions/registry';
  import { formatKeys, shortcutFor } from '$lib/actions/shortcuts';
  import { commands } from '$lib/ipc/commands';
  import { featureFlags } from '$lib/feature-flags';

  import { openDialog } from '$lib/dialogs/registry';
  import { app } from '$lib/stores/app.svelte';
  import { github } from '$lib/stores/github.svelte';

  import { t } from '$i18n/index';
  import Icon from '../ui/Icon.svelte';
  import type { IconName } from '../ui/icons';
  import MenuList, { type MenuListItem } from '../menu/MenuList.svelte';

  const head = $derived(repo.head);
  const hasRepo = $derived(repo.isOpen);

  const branchLabel = $derived.by(() => {
    if (!head) return '';
    if (head.detached) return t('toolbar.detached', { sha: (head.oid ?? '').slice(0, 7) });
    if (head.unborn) return t('toolbar.unborn', { name: head.branch ?? '' });
    return head.branch ?? '';
  });

  /** Reason for deactivation of an action (`null` = activated), dependent on the stores therefore reactive. */
  function reason(id: string): string | null {
    const a = getAction(id);
    if (!a) return t('action.noRepo');
    return actionDisabledReason(a, actionContext());
  }
  function tip(id: string, fallback: string): string {
    const r = reason(id);
    const keys = shortcutFor(id);
    if (r) return r;
    return keys ? `${fallback} (${formatKeys(keys)})` : fallback;
  }
  const off = (id: string) => reason(id) !== null;

  // - - Cancel
  const undoReason = $derived(reason('undo.last'));

  // ── Ahead/behind
  const ahead = $derived(status.ahead);
  const behind = $derived(status.behind);
  const showAheadBehind = $derived(status.upstream !== null && ahead !== null && behind !== null);

  let pullMenuOpen = $state(false);
  let pullBtn = $state<HTMLButtonElement | null>(null);
  function closeMenus(refocus = true): void {
    pullMenuOpen = false;
    if (refocus) pullBtn?.focus();
  }

  const pullItems = $derived.by<MenuListItem[]>(() => [
    { key: 'fetch', label: t('toolbar.pullMenu.fetch'), testid: 'toolbar-pull-menu-item-fetch', disabled: off('git.fetch'), onselect: () => { closeMenus(false); void runAction('git.fetch'); } },
    { key: 'ff-only', label: t('toolbar.pullMenu.ffOnly'), testid: 'toolbar-pull-menu-item-ff-only', disabled: off('git.pullFfOnly'), onselect: () => { closeMenus(false); void runAction('git.pullFfOnly'); } },
    { key: 'rebase', label: t('toolbar.pullMenu.rebase'), testid: 'toolbar-pull-menu-item-rebase', disabled: off('git.pullRebase'), onselect: () => { closeMenus(false); void runAction('git.pullRebase'); } },
  ]);

  function onWindowPointerDown(e: PointerEvent): void {
    if (!pullMenuOpen) return;
    if ((e.target as Element | null)?.closest('[data-dropdown]')) return;
    closeMenus(false);
  }

  function onDropdownKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeMenus();
    }
  }

  // "Progress and cancellation of an order [L]
  const progress = $derived(op.inflight?.opId ? op.inflight : null);
  const progressText = $derived.by(() => {
    if (!progress) return '';
    const base = progress.progressLabel ?? progress.label;
    return progress.percent !== null ? `${base} ${Math.round(progress.percent)} %` : base;
  });

  async function cancelOp(): Promise<void> {
    const id = op.inflight?.opId;
    if (!id) return;
    try {
      await commands.opCancel({ opId: id });
    } catch (e) {
      reportError(e, { command: 'op_cancel' });
    }
  }

  function selectCurrentBranch(): void {
    const el = document.querySelector<HTMLElement>('[data-testid="sidebar-branch-item"][data-current="true"]');
    el?.focus();
    el?.scrollIntoView?.({ block: 'nearest' });
    const oid = head?.oid;
    if (oid) void graph.reveal(oid);
  }

  let githubBtn = $state<HTMLButtonElement | null>(null);
  function toggleGithub(): void {
    if (!githubBtn) return;
    void github.ensureLoaded();
    ui.togglePopover('github-menu', githubBtn);
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

{#snippet tbtn(id: string, testid: string, icon: IconName, label: string, extra?: string)}
  <button
    type="button"
    class="tb"
    data-testid={testid}
    disabled={off(id)}
    title={tip(id, label)}
    aria-label={label}
    onclick={() => void runAction(id)}
  >
    <Icon name={icon} />
    <span class="lbl">{extra ?? label}</span>
  </button>
{/snippet}

<header class="toolbar" data-testid="toolbar" aria-label="Barre d’tools">
  <div class="tb repo" data-testid="toolbar-repo-name" title={repo.info?.workdir}>
    <Icon name="folder" />
    <span class="lbl-always truncate">{repo.name || t('toolbar.noRepo')}</span>
  </div>

  <!-- Branche courante -->
  <button type="button" class="tb branch-current" data-testid="toolbar-current-branch" disabled={!hasRepo} title={t('toolbar.currentBranch')} onclick={selectCurrentBranch}>
    <Icon name="branch" />
    <span class="lbl-always truncate">{branchLabel}</span>
  </button>
  {#if head?.detached}
    <button type="button" class="tb" data-testid="branch-create-here-btn" disabled={off('branch.create')} onclick={() => void openDialog('branch-create-dialog', { startPoint: 'HEAD', checkout: true })}>
      <Icon name="plus" />
      <span class="lbl-always">{t('toolbar.createBranchHere')}</span>
    </button>
  {/if}

  <span class="sep"></span>

  <!-- Cancel / reflog -->
  <button
    type="button"
    class="tb"
    data-testid="toolbar-undo-btn"
    disabled={undoReason !== null}
    title={undoReason || undo.tooltip}
    aria-label={t('toolbar.undo')}
    onclick={() => void runAction('undo.last')}
  >
    <Icon name="undo" />
    <span class="lbl">{t('toolbar.undo')}</span>
  </button>
  <button type="button" class="tb" data-testid="reflog-panel-btn" disabled={!hasRepo} aria-pressed={ui.drawer === 'reflog-panel'} title={t('toolbar.reflog')} aria-label={t('toolbar.reflog')} onclick={() => ui.toggleDrawer('reflog-panel')}>
    <Icon name="history" />
    <span class="lbl">{t('toolbar.reflog')}</span>
  </button>

  <span class="sep"></span>

  <!-- Fetch / Pull / Push -->
  {@render tbtn('git.fetch', 'toolbar-fetch-btn', 'fetch', t('toolbar.fetch'))}
  <div class="split dd" data-dropdown>
    <button type="button" class="tb split-main" data-testid="toolbar-pull-btn" disabled={off('git.pull')} title={tip('git.pull', t('toolbar.pull'))} aria-label={t('toolbar.pull')} onclick={() => void runAction('git.pull')}>
      <Icon name="pull" />
      <span class="lbl">{t('toolbar.pull')}</span>
    </button>
    <button
      bind:this={pullBtn}
      type="button"
      class="tb split-arrow"
      data-testid="toolbar-pull-menu-btn"
      aria-haspopup="menu"
      aria-expanded={pullMenuOpen}
      aria-label={t('toolbar.pullMenu')}
      disabled={!hasRepo}
      onclick={() => { pullMenuOpen = !pullMenuOpen; }}
    >
      <Icon name="chevron-down" size={12} />
    </button>
    {#if pullMenuOpen}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="panel" onkeydown={onDropdownKey}>
        <MenuList items={pullItems} testid="toolbar-pull-menu" label={t('toolbar.pullMenu')} onclose={() => closeMenus()} />
      </div>
    {/if}
  </div>
  {@render tbtn('git.push', 'toolbar-push-btn', 'push', t('toolbar.push'))}
  {#if showAheadBehind}
    <span
      class="ahead-behind"
      class:disabled={head?.detached}
      data-testid="toolbar-ahead-behind"
      data-ahead={ahead}
      data-behind={behind}
      title={t('toolbar.aheadBehind', { ahead: ahead ?? 0, behind: behind ?? 0 })}
    >↑{ahead} ↓{behind}</span>
  {/if}

  <span class="sep"></span>

  <!-- Branche / stash / pop -->
  {@render tbtn('branch.create', 'toolbar-branch-btn', 'branch', t('toolbar.branch'))}
  <div class="split">
    <button type="button" class="tb split-main" data-testid="toolbar-stash-btn" disabled={off('stash.save')} title={tip('stash.save', t('toolbar.stash'))} aria-label={t('toolbar.stash')} onclick={() => void runAction('stash.save')}>
      <Icon name="stash" />
      <span class="lbl">{t('toolbar.stash')}</span>
    </button>
    <button type="button" class="tb split-arrow" data-testid="toolbar-stash-menu-btn" disabled={off('stash.dialog')} aria-label={t('toolbar.stashMenu')} title={t('toolbar.stashMenu')} onclick={() => void runAction('stash.dialog')}>
      <Icon name="chevron-down" size={12} />
    </button>
  </div>
  {@render tbtn('stash.pop', 'toolbar-pop-btn', 'pop', t('toolbar.pop'))}

  <span class="spacer"></span>

  <!-- Progression of a command [L] -->
  {#if progress}
    <div class="progress" data-testid="toolbar-op-progress" data-op-id={progress.opId} role="status">
      <span class="bar" style:width="{progress.percent ?? 0}%"></span>
      <span class="progress-text truncate">{progressText}</span>
    </div>
    <button type="button" class="tb" data-testid="toolbar-op-cancel-btn" title={t('toolbar.cancelOp')} aria-label={t('toolbar.cancelOp')} onclick={() => void cancelOp()}>
      <Icon name="stop" />
      <span class="lbl-always">{t('toolbar.cancelOp')}</span>
    </button>
  {/if}

  <!-- Search, palette, account, settings -->
  <button type="button" class="tb icon" data-testid="toolbar-search-btn" disabled={off('graph.search')} title={tip('graph.search', t('toolbar.search'))} aria-label={t('toolbar.search')} onclick={() => void runAction('graph.search')}>
    <Icon name="search" />
  </button>
  <button type="button" class="tb icon" data-testid="toolbar-palette-btn" title={tip('palette.open', t('toolbar.palette'))} aria-label={t('toolbar.palette')} onclick={() => void runAction('palette.open')}>
    <Icon name="palette" />
  </button>
  {#if featureFlags.githubLogin}
    <button bind:this={githubBtn} type="button" class="tb icon" data-testid="toolbar-github-btn" aria-haspopup="menu" aria-expanded={ui.popover?.id === 'github-menu'} title={github.loggedIn ? `${t('toolbar.github')} : ${github.login ?? ''}` : t('toolbar.github')} aria-label={t('toolbar.github')} onclick={toggleGithub}>
      <Icon name="user" />
    </button>
  {/if}
  <button type="button" class="tb icon" data-testid="toolbar-settings-btn" title={tip('settings.open', t('toolbar.settings'))} aria-label={t('toolbar.settings')} onclick={() => void runAction('settings.open')}>
    <Icon name="settings" />
  </button>
  <button type="button" class="tb icon" data-testid="layout-sidebar-toggle-btn" disabled={!hasRepo} aria-pressed={!app.layout.leftCollapsed} title={t('layout.toggleSidebar')} aria-label={t('layout.toggleSidebar')} onclick={() => void app.set('layout', { ...app.layout, leftCollapsed: !app.layout.leftCollapsed })}>
    <Icon name="panel-left" />
  </button>
  <button type="button" class="tb icon" data-testid="layout-right-toggle-btn" disabled={!hasRepo} aria-pressed={!app.layout.rightCollapsed} title={t('layout.toggleRight')} aria-label={t('layout.toggleRight')} onclick={() => { if (ui.narrow) ui.rightOverlayOpen = !ui.rightOverlayOpen; else void app.set('layout', { ...app.layout, rightCollapsed: !app.layout.rightCollapsed }); }}>
    <Icon name="panel-right" />
  </button>
</header>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
    height: var(--toolbar-height);
    padding: 0 8px;
    background: var(--bg-elev);
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .tb {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 8px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--fg);
    white-space: nowrap;
  }
  .tb:hover:not(:disabled) {
    background: var(--row-hover);
  }
  .tb:disabled {
    opacity: 0.45;
  }
  .tb[aria-pressed='true'] {
    background: var(--row-selected);
  }
  .tb.icon {
    width: 30px;
    padding: 0;
    justify-content: center;
  }
  .repo {
    max-width: 200px;
    font-weight: 600;
  }
  .branch-current {
    max-width: 220px;
    color: var(--accent);
  }
  .sep {
    width: 1px;
    height: 20px;
    margin: 0 4px;
    background: var(--border);
    flex: none;
  }
  .spacer {
    flex: 1;
  }
  .dd {
    position: relative;
  }
  .panel {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: var(--z-menu);
  }
  .split {
    display: inline-flex;
    position: relative;
  }
  .split-main {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }
  .split-arrow {
    padding: 0 4px;
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    border-left: 1px solid var(--border);
  }
  .ahead-behind {
    padding: 0 6px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--fg-muted);
  }
  .ahead-behind.disabled {
    opacity: 0.45;
  }
  .progress {
    position: relative;
    width: 200px;
    height: 24px;
    margin-right: 4px;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
  }
  .bar {
    position: absolute;
    inset: 0 auto 0 0;
    background: var(--row-selected);
    transition: width 0.15s linear;
  }
  .progress-text {
    position: relative;
    display: block;
    padding: 0 8px;
    line-height: 22px;
    font-size: 12px;
  }
  @media (max-width: 1280px) {
    .lbl {
      display: none;
    }
  }
</style>
