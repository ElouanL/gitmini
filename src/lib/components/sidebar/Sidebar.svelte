<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { graph, op, refs, repo, ui } = captureStores();
  // Left sidebar (03): LOCAL, REMOTE, TAGS, STASHES. Data: `refs_list`, `remote_list`, `stash_list`.
  // Backend order is kept (current branch first, tags by decreasing version): the front does not re-sort. Names are
  // grouped in folders by `/` prefix (`feature/login` under `feature`), and the filter box narrows all four lists.
  import { checkoutTarget } from '$lib/actions/checkout';
  import { contextMenu } from '$lib/actions/context-menu';
  import { runAction } from '$lib/actions/registry';
  import { roving } from '$lib/actions/roving';
  import { isTextInput } from '$lib/actions/shortcuts';
  import { openDialog } from '$lib/dialogs/registry';
  import { formatRelative } from '$lib/format';
  import type { BranchInfo, RemoteBranchInfo, StashEntry, TagInfo } from '$lib/ipc/types';

  import { t, tp } from '$i18n/index';
  import Icon from '../ui/Icon.svelte';
  import { buildRows, filterItems, filterTerms, folderKey, sectionKey, treePositions, type FolderRow, type TreePosition } from './ref-tree';

  type SectionKey = 'local' | 'remote' | 'tags' | 'stashes';

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

  // 03 "Toolbar": only the writings that the backend would refuse are disabled. Create a branch or add a remote
  // is refused only if a write is in flight; `stash_save` is also refused during a state-of-the-art operation; a checkout in both cases.
  const writeBlocked = $derived(op.blockReason('write') !== null);
  const createBranchReason = $derived(op.blockReason('branch'));
  const stashReason = $derived(op.blockReason('write'));
  // A tag is made on a commit and touches no state: like a branch without checkout, only a write in flight or an unborn HEAD refuses it.
  const createTagReason = $derived(repo.head?.unborn ? t('tags.create.noCommit') : op.blockReason('branch'));

  // ── Filter
  const terms = $derived(filterTerms(ui.sidebarFilter));
  const filtering = $derived(terms.length > 0);

  const stashText = (s: StashEntry): string => `stash@{${s.index}} ${s.message}`;
  const shownLocals = $derived(filterItems(locals, terms, (b) => b.name));
  const shownTags = $derived(filterItems(tags, terms, (tag) => tag.name));
  const shownStashes = $derived(filterItems(stashes, terms, stashText));

  // ── Open / closed state. A section, a remote or a folder is open according to its own state; while filtering it is
  // open unless the user closed it since the last keystroke, so that every match is visible without extra clicks.
  function isOpen(key: string, stored: boolean): boolean {
    return filtering ? !ui.sidebarFilterClosed[key] : stored;
  }

  function toggleKey(key: string, stored: boolean, store: (value: boolean) => void): void {
    if (filtering) ui.sidebarFilterClosed[key] = !ui.sidebarFilterClosed[key];
    else store(!stored);
  }

  const sectionOpen = (key: SectionKey): boolean => isOpen(sectionKey(key), ui.sidebarOpen[key]);
  const toggleSection = (key: SectionKey): void => toggleKey(sectionKey(key), ui.sidebarOpen[key], (v) => (ui.sidebarOpen[key] = v));

  const remoteExpanded = (remote: string): boolean => isOpen(`r:${remote}`, ui.sidebarRemotesOpen[remote] ?? true);
  const toggleRemote = (remote: string): void => toggleKey(`r:${remote}`, ui.sidebarRemotesOpen[remote] ?? true, (v) => (ui.sidebarRemotesOpen[remote] = v));

  const folderOpen = (scope: string, path: string): boolean => isOpen(folderKey(scope, path), ui.sidebarFoldersOpen[folderKey(scope, path)] ?? true);
  const toggleFolder = (scope: string, path: string): void => {
    const key = folderKey(scope, path);
    toggleKey(key, ui.sidebarFoldersOpen[key] ?? true, (v) => (ui.sidebarFoldersOpen[key] = v));
  };

  // ── Rows (folders and leaves, flattened)
  const localRows = $derived(buildRows(shownLocals, (b) => b.name, (path) => folderOpen('local', path), (b) => b.isHead));
  const tagRows = $derived(buildRows(shownTags, (tag) => tag.name, (path) => folderOpen('tags', path)));
  // The lists are drawn flat (depth is an indent); a screen reader gets the tree from `aria-level` / `aria-posinset` / `aria-setsize`.
  const localPos = $derived(treePositions(localRows));
  const tagPos = $derived(treePositions(tagRows));

  const remoteGroups = $derived.by(() => {
    return remoteNames.flatMap((name) => {
      const all = remoteBranches.filter((b) => b.remote === name);
      // `origin/feature/login`: the remote name takes part in the match, so typing `origin` keeps its branches.
      const shown = filterItems(all, terms, (b) => `${b.remote}/${b.name}`);
      if (filtering && shown.length === 0) return [];
      const scope = `remote:${name}`;
      const rows = buildRows(shown, (b) => b.name, (path) => folderOpen(scope, path));
      // The branches hang under their remote, which is a top level item: they start at level 2.
      return [{
        name,
        info: refs.remotes.find((r) => r.name === name),
        total: all.length,
        shown: shown.length,
        rows,
        pos: treePositions(rows, 2),
      }];
    });
  });

  const matchCount = $derived(shownLocals.length + remoteGroups.reduce((n, g) => n + g.shown, 0) + shownTags.length + shownStashes.length);
  const filterText = $derived(ui.sidebarFilter.trim());
  const filterStatus = $derived(!filtering ? '' : matchCount === 0 ? t('sidebar.filter.empty', { query: filterText }) : tp('sidebar.filter.summary', matchCount));

  /** `12`, or `3/12` while filtering. */
  const countText = (shown: number, total: number): string => (filtering ? `${shown}/${total}` : String(total));

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
    } else if (e.key === 'Delete') {
      // No confirmation, as in the menu: the toast and Mod+Z undo it. `runAction` refuses while a write is in flight.
      e.preventDefault();
      void runAction('tag.delete', { menu: 'tag', tag });
    }
  }

  /** Remote and folder rows: → opens, ← closes (Enter and Space toggle, as for any button). */
  function onToggleKey(e: KeyboardEvent, expanded: boolean, toggle: () => void): void {
    if ((e.key === 'ArrowRight' && !expanded) || (e.key === 'ArrowLeft' && expanded)) {
      e.preventDefault();
      toggle();
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

  // ── Filter box: Escape clears, then leaves the field; ↓ / Enter jump to the first result; `/` in the lists comes back.
  let nav = $state<HTMLElement | null>(null);
  let filterInput = $state<HTMLInputElement | null>(null);

  function focusFirstResult(): void {
    // A leaf (no `aria-expanded`) rather than a folder, so that Enter right after checks out the branch under the cursor.
    const target = nav?.querySelector<HTMLElement>('[data-roving]:not([aria-expanded])') ?? nav?.querySelector<HTMLElement>('[data-roving]');
    if (target) target.focus();
    else filterInput?.blur();
  }

  function onFilterKey(e: KeyboardEvent): void {
    if (e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (ui.sidebarFilter !== '') ui.setSidebarFilter('');
      else focusFirstResult();
    } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
      e.preventDefault();
      focusFirstResult();
    }
  }

  function clearFilter(): void {
    ui.setSidebarFilter('');
    filterInput?.focus();
  }

  /** `/` in the lists puts the caret in the filter field (outside any text field, so typing a slash there is untouched). */
  function filterShortcut(node: HTMLElement) {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== '/' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTextInput(e.target)) return;
      e.preventDefault();
      filterInput?.focus();
      filterInput?.select();
    };
    node.addEventListener('keydown', onKeyDown);
    return { destroy: () => node.removeEventListener('keydown', onKeyDown) };
  }
</script>

{#snippet header(key: SectionKey, title: string, count: string)}
  {@const expanded = sectionOpen(key)}
  <button type="button" class="head" aria-expanded={expanded} title={expanded ? t('sidebar.collapse') : t('sidebar.expand')} onclick={() => toggleSection(key)}>
    <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
    <span class="title">{title}</span>
    <span class="count" data-testid="sidebar-{key === 'stashes' ? 'stash' : key}-count">({count})</span>
  </button>
{/snippet}

<!-- Prefix folder of a list; `scope` is `local`, `tags` or `remote:<name>`. -->
{#snippet folder(row: FolderRow, scope: string, pos: TreePosition)}
  <li role="none">
    <!-- A tree of references, drawn flat: `aria-selected` is optional for a tree item in ARIA 1.2, and nothing here is "selected". -->
    <!-- svelte-ignore a11y_role_has_required_aria_props -->
    <button
      type="button"
      role="treeitem"
      class="item folder"
      data-roving
      data-testid="sidebar-folder-item"
      data-scope={scope}
      data-folder={row.path}
      data-zone-focus={row.flagged && !row.open ? '' : undefined}
      aria-expanded={row.open}
      aria-level={pos.level}
      aria-setsize={pos.setsize}
      aria-posinset={pos.posinset}
      title={row.path}
      style:--depth={row.depth}
      onclick={() => toggleFolder(scope, row.path)}
      onkeydown={(e) => onToggleKey(e, row.open, () => toggleFolder(scope, row.path))}
    >
      <Icon name={row.open ? 'chevron-down' : 'chevron-right'} size={12} />
      <Icon name="folder" size={14} />
      <span class="name truncate">{row.name}</span>
      {#if row.flagged && !row.open}<span class="dot" role="img" aria-label={t('sidebar.folderCurrent')}></span>{/if}
      <span class="count">({row.count})</span>
    </button>
  </li>
{/snippet}

<nav class="sidebar" aria-label={t('sidebar.label')} data-zone="sidebar" bind:this={nav} use:roving={'[data-roving]'} use:filterShortcut>
  <!-- FILTER -->
  <div class="filter" role="search" data-testid="sidebar-filter">
    <div class="filter-field">
      <span class="filter-icon"><Icon name="search" size={13} /></span>
      <input
        bind:this={filterInput}
        class="input"
        type="text"
        role="searchbox"
        data-testid="sidebar-filter-input"
        data-sidebar-filter
        aria-label={t('sidebar.filter.label')}
        title={t('sidebar.filter.hint')}
        placeholder={t('sidebar.filter.placeholder')}
        value={ui.sidebarFilter}
        oninput={(e) => ui.setSidebarFilter(e.currentTarget.value)}
        onkeydown={onFilterKey}
        spellcheck="false"
        autocomplete="off"
      />
      {#if ui.sidebarFilter !== ''}
        <button type="button" class="icon-btn small clear" data-testid="sidebar-filter-clear-btn" title={t('sidebar.filter.clear')} aria-label={t('sidebar.filter.clear')} onclick={clearFilter}>
          <Icon name="x" size={12} />
        </button>
      {/if}
    </div>
    <span class="sr-only" role="status" data-testid="sidebar-filter-status">{filterStatus}</span>
  </div>

  {#if filtering && matchCount === 0}
    <p class="no-match" data-testid="sidebar-filter-empty">{t('sidebar.filter.empty', { query: filterText })}</p>
  {/if}

  <!-- LOCAL -->
  {#if !filtering || shownLocals.length > 0}
    <section data-testid="sidebar-local-section" class="section">
      <div class="section-head">
        {@render header('local', t('sidebar.local'), countText(shownLocals.length, locals.length))}
        <button type="button" class="icon-btn small" data-testid="sidebar-branch-create-btn" disabled={createBranchReason !== null} title={createBranchReason ?? t('sidebar.createBranch')} aria-label={t('sidebar.createBranch')} onclick={() => void openDialog('branch-create-dialog', { startPoint: null })}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      {#if sectionOpen('local')}
        <ul role={localRows.length > 0 ? 'tree' : undefined} aria-label={t('sidebar.local')}>
          {#each localRows as row, i (row.key)}
            {#if row.kind === 'folder'}
              {@render folder(row, 'local', localPos[i]!)}
            {:else}
              {@const b = row.item}
              {@const pos = localPos[i]!}
              <li role="none">
                <!-- svelte-ignore a11y_role_has_required_aria_props -->
                <button
                  type="button"
                  role="treeitem"
                  class="item"
                  class:current={b.isHead}
                  aria-level={pos.level}
                  aria-setsize={pos.setsize}
                  aria-posinset={pos.posinset}
                  data-roving
                  data-testid="sidebar-branch-item"
                  data-ref={b.fullRef}
                  data-current={b.isHead ? 'true' : 'false'}
                  data-zone-focus={b.isHead ? '' : undefined}
                  title={b.name}
                  style:--depth={row.depth}
                  use:contextMenu={() => ({ menu: 'branch', branch: b })}
                  onclick={() => selectOid(b.oid)}
                  ondblclick={() => checkoutLocal(b)}
                  onkeydown={(e) => onBranchKey(e, b)}
                >
                  <Icon name="branch" size={14} />
                  <span class="name truncate">{row.label}</span>
                  {#if b.upstream}
                    <span class="badge" class:gone={b.upstream.gone} title={b.upstream.gone ? t('sidebar.goneTitle') : (b.upstream.ref)}>{upstreamText(b)}</span>
                  {/if}
                  {#if b.isHead}<span class="dot" role="img" aria-label={t('sidebar.current')}></span>{/if}
                </button>
              </li>
            {/if}
          {:else}
            <li class="empty">{t('sidebar.empty.local')}</li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

  <!-- REMOTE -->
  {#if !filtering || remoteGroups.length > 0}
    <section data-testid="sidebar-remote-section" class="section">
      <div class="section-head">
        {@render header('remote', t('sidebar.remote'), countText(remoteGroups.length, remoteNames.length))}
        <button type="button" class="icon-btn small" data-testid="sidebar-remote-add-btn" disabled={createBranchReason !== null} title={createBranchReason ?? t('sidebar.addRemote')} aria-label={t('sidebar.addRemote')} onclick={() => void openDialog('remote-add-dialog', {})}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      {#if sectionOpen('remote')}
        <ul role={remoteGroups.length > 0 ? 'tree' : undefined} aria-label={t('sidebar.remote')}>
          {#each remoteGroups as g, gi (g.name)}
            {@const expanded = remoteExpanded(g.name)}
            <li role="none">
              <!-- svelte-ignore a11y_role_has_required_aria_props -->
              <button
                type="button"
                role="treeitem"
                class="item remote"
                aria-level="1"
                aria-setsize={remoteGroups.length}
                aria-posinset={gi + 1}
                data-roving
                data-testid="sidebar-remote-item"
                data-remote={g.name}
                aria-expanded={expanded}
                title={g.info?.fetchUrl ?? g.name}
                use:contextMenu={() => (g.info ? { menu: 'remote', remote: g.info } : null)}
                onclick={() => toggleRemote(g.name)}
                onkeydown={(e) => onToggleKey(e, expanded, () => toggleRemote(g.name))}
              >
                <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
                <Icon name="cloud" size={14} />
                <span class="name truncate">{g.name}</span>
                <span class="count">({countText(g.shown, g.total)})</span>
              </button>
              {#if expanded}
                <ul class="remote-branches" role={g.rows.length > 0 ? 'group' : undefined}>
                  {#each g.rows as row, i (row.key)}
                    {#if row.kind === 'folder'}
                      {@render folder(row, `remote:${g.name}`, g.pos[i]!)}
                    {:else}
                      {@const b = row.item}
                      {@const pos = g.pos[i]!}
                      <li role="none">
                        <!-- svelte-ignore a11y_role_has_required_aria_props -->
                        <button
                          type="button"
                          role="treeitem"
                          class="item"
                          aria-level={pos.level}
                          aria-setsize={pos.setsize}
                          aria-posinset={pos.posinset}
                          data-roving
                          data-testid="sidebar-remote-branch-item"
                          data-ref={b.fullRef}
                          title={`${b.remote}/${b.name}`}
                          style:--depth={row.depth}
                          use:contextMenu={() => ({ menu: 'remote-branch', branch: b })}
                          onclick={() => selectOid(b.oid)}
                          ondblclick={() => checkoutRemote(b)}
                          onkeydown={(e) => onRemoteBranchKey(e, b)}
                        >
                          <Icon name="branch" size={14} />
                          <span class="name truncate">{row.label}</span>
                        </button>
                      </li>
                    {/if}
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
  {/if}

  <!-- TAGS -->
  {#if !filtering || shownTags.length > 0}
    <section data-testid="sidebar-tags-section" class="section">
      <div class="section-head">
        {@render header('tags', t('sidebar.tags'), countText(shownTags.length, tags.length))}
        <button type="button" class="icon-btn small" data-testid="sidebar-tag-create-btn" disabled={createTagReason !== null} title={createTagReason ?? t('sidebar.createTag')} aria-label={t('sidebar.createTag')} onclick={() => void openDialog('tag-create-dialog', { target: null })}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      {#if sectionOpen('tags')}
        <ul role={tagRows.length > 0 ? 'tree' : undefined} aria-label={t('sidebar.tags')}>
          {#each tagRows as row, i (row.key)}
            {#if row.kind === 'folder'}
              {@render folder(row, 'tags', tagPos[i]!)}
            {:else}
              {@const tag = row.item}
              {@const pos = tagPos[i]!}
              <li role="none">
                <!-- svelte-ignore a11y_role_has_required_aria_props -->
                <button
                  type="button"
                  role="treeitem"
                  class="item"
                  aria-level={pos.level}
                  aria-setsize={pos.setsize}
                  aria-posinset={pos.posinset}
                  data-roving
                  data-testid="sidebar-tag-item"
                  data-ref={tag.fullRef}
                  data-annotated={tag.annotated ? 'true' : 'false'}
                  title={tag.name}
                  style:--depth={row.depth}
                  use:contextMenu={() => ({ menu: 'tag', tag })}
                  onclick={() => selectOid(tag.targetOid)}
                  ondblclick={() => checkoutTag(tag)}
                  onkeydown={(e) => onTagKey(e, tag)}
                >
                  <Icon name="tag" size={14} />
                  <span class="name truncate">{row.label}</span>
                </button>
              </li>
            {/if}
          {:else}
            <li class="empty">{t('sidebar.empty.tags')}</li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

  <!-- STASHES -->
  {#if !filtering || shownStashes.length > 0}
    <section data-testid="sidebar-stash-section" class="section">
      <div class="section-head">
        {@render header('stashes', t('sidebar.stashes'), countText(shownStashes.length, stashes.length))}
        <button type="button" class="icon-btn small" data-testid="sidebar-stash-save-btn" disabled={stashReason !== null} title={stashReason ?? t('sidebar.saveStash')} aria-label={t('sidebar.saveStash')} onclick={() => void openDialog('stash-save-dialog', {})}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      {#if sectionOpen('stashes')}
        <ul>
          {#each shownStashes as s (s.oid + ':' + s.index)}
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
  {/if}
</nav>

<style>
  .sidebar {
    height: 100%;
    overflow: auto;
    padding: 0 0 16px;
    background: var(--bg-elev);
    user-select: none;
  }
  .filter {
    position: sticky;
    top: 0;
    z-index: 1;
    padding: 6px 8px;
    margin-bottom: 4px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-elev);
  }
  .filter-field {
    position: relative;
  }
  .filter-field .input {
    padding-right: 28px;
    padding-left: 26px;
    user-select: text;
  }
  .filter-icon {
    position: absolute;
    top: 50%;
    left: 8px;
    display: flex;
    transform: translateY(-50%);
    color: var(--fg-muted);
    pointer-events: none;
  }
  .clear {
    position: absolute;
    top: 3px;
    right: 3px;
  }
  .no-match {
    margin: 0;
    padding: 4px 12px 8px;
    color: var(--fg-muted);
    font-size: 12px;
    overflow-wrap: anywhere;
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
    flex: none;
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
    /* `--base` is the indent of the list, `--depth` the number of folders above the row (18px: chevron and gap, so a leaf lines up with the icon of its folder). */
    padding: 0 8px 0 calc(var(--base, 12px) + var(--depth, 0) * 18px);
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
    --base: 8px;
  }
  .remote-branches {
    --base: 32px;
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
