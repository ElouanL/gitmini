<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { graph, op, refs, ui } = captureStores();
  // Left sidebar (03): LOCAL, REMOTE, TAGS (read only), STASHES. Data: `refs_list`, `remote_list`, `stash_list`.
  // No filter or branch folders in v1 (03 "Out of perimeter"). Flat list sorted by name.
  import { checkoutTarget } from '$lib/actions/checkout';
  import { contextMenu } from '$lib/actions/context-menu';
  import { roving } from '$lib/actions/roving';
  import { openDialog } from '$lib/dialogs/registry';
  import { formatRelative } from '$lib/format';
  import type { BranchInfo, RemoteBranchInfo, StashEntry, TagInfo } from '$lib/ipc/types';

  import { t } from '$i18n/index';
  import Icon from '../ui/Icon.svelte';

  const snapshot = $derived(refs.snapshot);
  // The order is backend (first current, tags by decreasing version, 06): the front does not re-trie anything.
  const locals = $derived(snapshot?.local ?? []);
  const remoteBranches = $derived(snapshot?.remote ?? []);
  const tags = $derived(snapshot?.tags ?? []);
  const stashes = $derived(refs.stashes);

  /** Remotes displayed: those of `remote_list`, plus those that only have tracking branches. */
  const remoteNames = $derived.by(() => {
    const names: string[] = refs.remotes.map((r) => r.name);
    for (const b of remoteBranches) if (!names.includes(b.remote)) names.push(b.remote);
    return names;
  });

  const open = ui.sidebarOpen;
  const remoteOpen = ui.sidebarRemotesOpen;

  // 03 "Toolbar": only the writings that the backend would refuse are disabled. Create a branch or add a remote
  // is refused only if a write is in flight; `stash_save` is also refused during a state-of-the-art operation; a checkout in both cases.
  const writeBlocked = $derived(op.blockReason('write') !== null);
  const createBranchReason = $derived(op.blockReason('branch'));
  const stashReason = $derived(op.blockReason('write'));

  function branchesOf(remote: string): RemoteBranchInfo[] {
    return remoteBranches.filter((b) => b.remote === remote);
  }

  // ── Actions
  const selectOid = (oid: string) => void graph.reveal(oid);

  function checkoutLocal(b: BranchInfo): void {
    if (b.isHead || writeBlocked) return;
    void checkoutTarget({ kind: "local", name: b.name });
  }

  function checkoutRemote(b: RemoteBranchInfo): void {
    if (writeBlocked) return;
    void checkoutTarget({ kind: 'remote', ref: `${b.remote}/${b.name}` });
  }

  function onBranchKey(e: KeyboardEvent, b: BranchInfo): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      checkoutLocal(b);
    } else if (e.key === 'F2') {
      e.preventDefault();
      void openDialog('branch-rename-dialog', { name: b.name });
    }
  }

  function onRemoteBranchKey(e: KeyboardEvent, b: RemoteBranchInfo): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      checkoutRemote(b);
    }
  }

  /** Tag: double-clic or Input → detached checkout from the pointed commit (06 "Interactions"). */
  function checkoutTag(tag: TagInfo): void {
    if (writeBlocked) return;
    void checkoutTarget({ kind: 'detached', oid: tag.targetOid });
  }

  function onTagKey(e: KeyboardEvent, tag: TagInfo): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      checkoutTag(tag);
    }
  }

  function selectStash(s: StashEntry): void {
    graph.selectStash(s.oid, s.index);
  }

  function stashLabel(s: StashEntry): string {
    return `stash@{${s.index}} · ${s.message} · ${formatRelative(s.time)}`;
  }

  function upstreamText(b: BranchInfo): string {
    const u = b.upstream;
    if (!u) return '';
    if (u.gone) return t('sidebar.gone');
    const parts: string[] = [];
    if (u.ahead !== null && u.ahead > 0) parts.push(`↑${u.ahead}`);
    if (u.behind !== null && u.behind > 0) parts.push(`↓${u.behind}`);
    return parts.join(' ');
  }
</script>

{#snippet header(key: 'local' | 'remote' | 'tags' | 'stashes', title: string, count: number)}
  <button type="button" class="head" aria-expanded={open[key]} title={open[key] ? t('sidebar.collapse') : t('sidebar.expand')} onclick={() => (open[key] = !open[key])}>
    <Icon name={open[key] ? 'chevron-down' : 'chevron-right'} size={12} />
    <span class="title">{title}</span>
    <span class="count">({count})</span>
  </button>
{/snippet}

<nav class="sidebar" aria-label={t('sidebar.label')} data-zone="sidebar" use:roving={'[data-roving]'}>
  <!-- LOCAL -->
  <section data-testid="sidebar-local-section" class="section">
    <div class="section-head">
      {@render header('local', t('sidebar.local'), locals.length)}
      <button type="button" class="icon-btn small" data-testid="sidebar-branch-create-btn" disabled={createBranchReason !== null} title={createBranchReason ?? t('sidebar.createBranch')} aria-label={t('sidebar.createBranch')} onclick={() => void openDialog('branch-create-dialog', { startPoint: null })}>
        <Icon name="plus" size={14} />
      </button>
    </div>
    {#if open.local}
      <ul>
        {#each locals as b (b.fullRef)}
          <li>
            <button
              type="button"
              class="item"
              class:current={b.isHead}
              data-roving
              data-testid="sidebar-branch-item"
              data-ref={b.fullRef}
              data-current={b.isHead ? 'true' : 'false'}
              data-zone-focus={b.isHead ? '' : undefined}
              title={b.name}
              use:contextMenu={() => ({ menu: 'branch', branch: b })}
              onclick={() => selectOid(b.oid)}
              ondblclick={() => checkoutLocal(b)}
              onkeydown={(e) => onBranchKey(e, b)}
            >
              <Icon name="branch" size={14} />
              <span class="name truncate">{b.name}</span>
              {#if b.upstream}
                <span class="badge" class:gone={b.upstream.gone} title={b.upstream.gone ? t('sidebar.goneTitle') : (b.upstream.ref)}>{upstreamText(b)}</span>
              {/if}
              {#if b.isHead}<span class="dot" role="img" aria-label={t('sidebar.current')}></span>{/if}
            </button>
          </li>
        {:else}
          <li class="empty">{t('sidebar.empty.local')}</li>
        {/each}
      </ul>
    {/if}
  </section>

  <!-- REMOTE -->
  <section data-testid="sidebar-remote-section" class="section">
    <div class="section-head">
      {@render header('remote', t('sidebar.remote'), remoteNames.length)}
      <button type="button" class="icon-btn small" data-testid="sidebar-remote-add-btn" disabled={createBranchReason !== null} title={createBranchReason ?? t('sidebar.addRemote')} aria-label={t('sidebar.addRemote')} onclick={() => void openDialog('remote-add-dialog', {})}>
        <Icon name="plus" size={14} />
      </button>
    </div>
    {#if open.remote}
      <ul>
        {#each remoteNames as remote (remote)}
          {@const expanded = remoteOpen[remote] ?? true}
          {@const branches = branchesOf(remote)}
          {@const info = refs.remotes.find((r) => r.name === remote)}
          <li>
            <button
              type="button"
              class="item remote"
              data-roving
              data-testid="sidebar-remote-item"
              data-remote={remote}
              aria-expanded={expanded}
              title={info?.fetchUrl ?? remote}
              use:contextMenu={() => (info ? { menu: 'remote', remote: info } : null)}
              onclick={() => (remoteOpen[remote] = !expanded)}
            >
              <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
              <Icon name="cloud" size={14} />
              <span class="name truncate">{remote}</span>
              <span class="count">({branches.length})</span>
            </button>
            {#if expanded}
              <ul class="nested">
                {#each branches as b (b.fullRef)}
                  <li>
                    <button
                      type="button"
                      class="item"
                      data-roving
                      data-testid="sidebar-remote-branch-item"
                      data-ref={b.fullRef}
                      title={`${b.remote}/${b.name}`}
                      use:contextMenu={() => ({ menu: 'remote-branch', branch: b })}
                      onclick={() => selectOid(b.oid)}
                      ondblclick={() => checkoutRemote(b)}
                      onkeydown={(e) => onRemoteBranchKey(e, b)}
                    >
                      <Icon name="branch" size={14} />
                      <span class="name truncate">{b.name}</span>
                    </button>
                  </li>
                {:else}
                  <li class="empty">{t('sidebar.remoteNoBranches')}</li>
                {/each}
              </ul>
            {/if}
          </li>
        {:else}
          <li class="empty">{t('sidebar.empty.remote')}</li>
        {/each}
      </ul>
    {/if}
  </section>

  <!-- TAGS (read only) -->
  <section data-testid="sidebar-tags-section" class="section">
    <div class="section-head">{@render header('tags', t('sidebar.tags'), tags.length)}</div>
    {#if open.tags}
      <ul>
        {#each tags as tag (tag.fullRef)}
          <li>
            <button
              type="button"
              class="item"
              data-roving
              data-testid="sidebar-tag-item"
              data-ref={tag.fullRef}
              title={tag.name}
              use:contextMenu={() => ({ menu: 'tag', tag })}
              onclick={() => selectOid(tag.targetOid)}
              ondblclick={() => checkoutTag(tag)}
              onkeydown={(e) => onTagKey(e, tag)}
            >
              <Icon name="tag" size={14} />
              <span class="name truncate">{tag.name}</span>
            </button>
          </li>
        {:else}
          <li class="empty">{t('sidebar.empty.tags')}</li>
        {/each}
      </ul>
    {/if}
  </section>

  <!-- STASHES -->
  <section data-testid="sidebar-stash-section" class="section">
    <div class="section-head">
      {@render header('stashes', t('sidebar.stashes'), stashes.length)}
      <button type="button" class="icon-btn small" data-testid="sidebar-stash-save-btn" disabled={stashReason !== null} title={stashReason ?? t('sidebar.saveStash')} aria-label={t('sidebar.saveStash')} onclick={() => void openDialog('stash-save-dialog', {})}>
        <Icon name="plus" size={14} />
      </button>
    </div>
    {#if open.stashes}
      <ul>
        {#each stashes as s (s.oid + ':' + s.index)}
          <li>
            <button
              type="button"
              class="item"
              data-roving
              data-testid="sidebar-stash-item"
              data-index={s.index}
              data-oid={s.oid}
              title={stashLabel(s)}
              use:contextMenu={() => ({ menu: 'stash', stash: s })}
              onclick={() => selectStash(s)}
            >
              <Icon name="stash" size={14} />
              <span class="name truncate">{stashLabel(s)}</span>
            </button>
          </li>
        {:else}
          <li class="empty">{t('sidebar.empty.stashes')}</li>
        {/each}
      </ul>
    {/if}
  </section>
</nav>

<style>
  .sidebar {
    height: 100%;
    overflow: auto;
    padding: 4px 0 16px;
    background: var(--bg-elev);
    user-select: none;
  }
  .section {
    margin-bottom: 4px;
  }
  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-right: 4px;
  }
  .head {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 4px;
    height: 28px;
    padding: 0 8px;
    border: 0;
    background: transparent;
    color: var(--fg-muted);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    text-align: left;
  }
  .head:hover {
    color: var(--fg);
  }
  .count {
    font-weight: 400;
    color: var(--fg-muted);
    letter-spacing: 0;
  }
  .icon-btn.small {
    width: 22px;
    height: 22px;
  }
  li {
    /* Long lists (thousands of tags / branches remote): the browser skips rendering of off-screen lines. */
    content-visibility: auto;
    contain-intrinsic-size: auto var(--row-height);
  }
  .item {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    height: var(--row-height);
    padding: 0 8px 0 12px;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--fg);
    text-align: left;
  }
  .item:hover {
    background: var(--row-hover);
  }
  .item:focus-visible {
    background: var(--row-selected);
    box-shadow: inset 0 0 0 2px var(--accent);
    border-radius: 0;
  }
  .item.current {
    font-weight: 600;
  }
  .item.remote {
    padding-left: 8px;
  }
  .nested .item {
    padding-left: 32px;
  }
  .name {
    flex: 1;
    min-width: 0;
  }
  .badge {
    flex: none;
    padding: 0 4px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-muted);
  }
  .badge.gone {
    color: var(--warn);
    font-family: inherit;
  }
  .dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
  }
  .empty {
    padding: 4px 12px 4px 28px;
    color: var(--fg-muted);
    font-size: 12px;
  }
</style>
