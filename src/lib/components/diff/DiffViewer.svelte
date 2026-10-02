<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { reportError: handleError, op, runWrite, session, status, ui } = captureStores();
  // Unified diff Viewer (05 "diff Viewer"), central view `diff` (`ui.openCenter('diff', { path, source })`).
  // Sources : unstaged, staged, commit (parent en base 1), range, stash, conflict (markers | ours | theirs).
  // Refreshing: `repo:changed { worktree | index | head }` restarts `diff_file` of the displayed file (mutable sources only).
  import { onMount, untrack } from 'svelte';
  import { commands } from '$lib/ipc/commands';
  import type { AppError, ConflictView, DiffSource, FileDiff } from '$lib/ipc/types';
  import { confirmAction } from '$lib/dialogs/confirm';

  import { onEvent } from '$lib/ipc/events';

  import { createCoalescer } from '$lib/stores/schedule';

  import { t } from '$i18n/index';
  import { openInEditor } from '../wt/actions';
  import RowIcon from '../wt/RowIcon.svelte';
  import { conflictLabels, conflictTabs } from './conflict';
  import { firstConflictLine, formatBytes, layoutDiff, modeChange } from './diff-layout';
  import { eventAffectsDiff, hunkActionsAllowed, sameDiff } from './diff-state';
  import DiffLines from './DiffLines.svelte';

  interface Props {
    path: string;
    source: DiffSource;
  }

  // The spaces around the arrow are part of the text ("old.txt → new.txt").
  const ARROW = ' → ';
  let { path, source }: Props = $props();

  // Conflict View (Tabs): starts from the one requested in each new file.
  let view = $state<ConflictView>('markers');
  let diff = $state.raw<FileDiff | null>(null);
  let loading = $state(false);
  let forcing = $state(false);
  let loadError = $state.raw<AppError | null>(null);
  let focusedHunk = $state<number | null>(null);
  let forced = false;
  let seq = 0;

  const sourceKind = $derived(source.kind);
  const effective = $derived<DiffSource>(source.kind === 'conflict' ? { kind: 'conflict', view } : source);
  const mutable = $derived(sourceKind === 'unstaged' || sourceKind === 'staged' || sourceKind === 'conflict');

  const entry = $derived(status.files.find((f) => f.path === path) ?? null);
  const conflictKind = $derived(entry?.conflict ?? null);
  const tabs = $derived(source.kind === 'conflict' ? conflictTabs(conflictKind) : []);
  const labels = $derived(conflictLabels(op.state));

  const layout = $derived(diff && !diff.binary && !diff.tooLarge && !diff.submodule ? layoutDiff(diff, { markers: source.kind === 'conflict' && view === 'markers' }) : null);
  const canHunk = $derived(hunkActionsAllowed(diff, sourceKind, entry?.nonUtf8 === true));

  async function load(opts: { silent?: boolean } = {}): Promise<void> {
    const repoId = session.repoId;
    if (repoId === null) return;
    const mine = ++seq;
    const gen = session.gen;
    if (!opts.silent) loading = true;
    try {
      const d = await commands.diffFile({ repoId, path, source: effective, ...(forced ? { force: true } : {}) });
      if (mine !== seq || !session.isCurrent(gen)) return;
      loadError = null;
      if (!sameDiff(diff, d)) diff = d;
    } catch (e) {
      if (mine !== seq) return;
      // Silent reloading: the old diff remains displayed; otherwise the error (toast of the base) and a "Retry" button.
      const err = handleError(e, { command: 'diff_file', ...(opts.silent ? { quiet: true } : {}) });
      if (!opts.silent) loadError = err;
    } finally {
      if (mine === seq) {
        loading = false;
        forcing = false;
      }
    }
  }

  // New file or new source: we start from scratch.
  let loadedFor: { path: string; source: DiffSource } | null = null;
  $effect(() => {
    const p = path;
    const s = source;
    if (loadedFor && loadedFor.path === p && loadedFor.source === s) return;
    loadedFor = { path: p, source: s };
    untrack(() => {
      view = s.kind === 'conflict' ? s.view : 'markers';
      forced = false;
      focusedHunk = null;
      diff = null;
      loadError = null;
      void load();
    });
  });

  // Changement d'onglet de conflit.
  function selectView(v: ConflictView): void {
    if (v === view) return;
    view = v;
    diff = null;
    focusedHunk = null;
    void load();
  }

  const refresher = createCoalescer(() => load({ silent: true }));

  onMount(() =>
    onEvent('repo:changed', (ev) => {
      if (ev.repoId !== session.repoId || !eventAffectsDiff(ev.kinds, sourceKind)) return;
      void refresher.trigger();
    }),
  );

  // Degraded watcher (limit inotify): no `repo:changed { worktree }` arrives, but the front rereads the status every 5 seconds:
  // each new status also rereads the diff displayed (even hash: nothing is redesigned).
  let lastSnapshot: unknown = null;
  $effect(() => {
    const snap = status.snapshot;
    if (snap === lastSnapshot) return;
    const first = lastSnapshot === null;
    lastSnapshot = snap;
    if (!first && snap?.watcherDegraded === true && untrack(() => mutable)) void refresher.trigger();
  });

  async function loadAnyway(): Promise<void> {
    forced = true;
    forcing = true;
    await load();
  }

  // "Hunks: the backend reconstructs the patch; only the displayed diff hash and index (05 "Stage a hunk").
  async function hunk(kind: 'stage' | 'unstage' | 'discard', index: number): Promise<void> {
    const d = diff;
    const repoId = session.repoId;
    if (!d || repoId === null) return;
    if (kind === 'discard') {
      const ok = await confirmAction({
        action: 'discard',
        danger: true,
        title: t('diff.hunk.discard.title'),
        message: t('diff.hunk.discard.message', { path: d.path }),
        confirmLabel: t('diff.hunk.discard.confirm'),
      }, session);
      if (!ok) return;
    }
    const args = { repoId, path: d.path, diffHash: d.hash, hunkIndex: index };
    const label = t(kind === 'stage' ? 'diff.op.stageHunk' : kind === 'unstage' ? 'diff.op.unstageHunk' : 'diff.op.discardHunk');
    const command = kind === 'stage' ? 'stage_hunk' : kind === 'unstage' ? 'unstage_hunk' : 'discard_hunk';
    const res = await runWrite(
      label,
      async () => {
        const snap = kind === 'stage' ? await commands.stageHunk(args) : kind === 'unstage' ? await commands.unstageHunk(args) : await commands.discardHunk(args);
        status.apply(snap);
        return snap;
      },
      {
        command,
        // Diff expired: nothing has been changed; the diff is reloaded without toast.
        onError: (e) => {
          if (e.code !== 'STALE' || e.details?.what !== 'diff') return false;
          void load({ silent: true });
          return true;
        },
      },
    );
    if (res.ok) {
      focusedHunk = null;
      await load({ silent: true });
    }
  }

  function onkeydown(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || !canHunk || op.busy) return;
    const index = focusedHunk ?? (diff?.hunks.length === 1 ? 0 : null);
    if (index === null) return;
    if (e.key === 's' && sourceKind === 'unstaged') {
      e.preventDefault();
      void hunk('stage', index);
    } else if (e.key === 'u' && sourceKind === 'staged') {
      e.preventDefault();
      void hunk('unstage', index);
    }
  }

  // - - Header and wording
  const title = $derived(diff?.path ?? path);
  const oldPath = $derived(diff?.oldPath ?? null);
  const mode = $derived(diff ? modeChange(diff) : null);
  const canOpenEditor = $derived(mutable && !(entry?.unstaged === 'deleted' && sourceKind === 'unstaged') && entry?.nonUtf8 !== true);
  const emptyKey = $derived(
    diff && diff.hunks.length === 0 && (diff.oldMode ?? null) !== (diff.newMode ?? null) && mode
      ? 'diff.modeOnly'
      : sourceKind === 'unstaged' ? 'diff.empty.unstaged' : sourceKind === 'staged' ? 'diff.empty.staged' : 'diff.empty',
  );

  function sizeText(d: FileDiff): string {
    const o = d.oldSize ?? null;
    const n = d.newSize ?? null;
    if (o !== null && n !== null) return t('diff.binary.sizes', { old: formatBytes(o), new: formatBytes(n) });
    if (n !== null) return t('diff.binary.added', { size: formatBytes(n) });
    if (o !== null) return t('diff.binary.deleted', { size: formatBytes(o) });
    return t('diff.binary');
  }

  function shortOid(oid: string | null | undefined): string {
    return oid ? oid.slice(0, 7) : t('diff.submodule.none');
  }

  function viewLabel(v: ConflictView): string {
    if (v === 'markers') return t('diff.conflict.tab.markers');
    const key = v === 'ours' ? labels.ours : labels.theirs;
    return t(`diff.conflict.label.${key}`, { incoming: op.state?.incoming?.replace(/^refs\/heads\//, '') ?? '' });
  }

  function editor(): void {
    const line = source.kind === 'conflict' && view === 'markers' && diff ? firstConflictLine(diff) : null;
    void openInEditor(path, line, session);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="viewer" data-testid="diff-viewer" data-source={sourceKind} data-view={source.kind === 'conflict' ? view : undefined} data-path={path} data-loading={loading ? 'true' : undefined} {onkeydown}>
  <header class="head" data-testid="diff-file-header">
    <span class="chip muted">{t(`diff.source.${sourceKind}`)}</span>
    <span class="path" title={oldPath ? t('diff.renamed', { old: oldPath, path: title }) : title}>
      {#if oldPath}<span class="old">{oldPath}</span><span class="arrow">{ARROW}</span>{/if}<strong>{title}</strong>
    </span>
    {#if mode}<code class="mode" data-testid="diff-mode-change">{mode}</code>{/if}
    {#if diff && diff.hunks.length > 0 && !diff.binary && !diff.tooLarge && !diff.submodule && !(source.kind === 'conflict' && view === 'markers')}
      <span class="stats mono" data-testid="diff-stats"><span class="add">+{diff.stats.added}</span> <span class="del">−{diff.stats.removed}</span></span>
    {/if}
    <span class="spacer"></span>
    {#if canOpenEditor}
      <button type="button" class="hbtn" data-testid="diff-open-external-btn" onclick={editor}>
        <RowIcon name="external" size={12} />{t('diff.openExternal')}
      </button>
    {/if}
    <button type="button" class="icon-btn" data-testid="diff-close-btn" title={t('diff.close')} aria-label={t('diff.close')} onclick={() => ui.closeCenter()}>
      <RowIcon name="close" size={14} />
    </button>
  </header>

  {#if source.kind === 'conflict'}
    <div class="banner" role="note" data-testid="diff-conflict-banner">{t('diff.conflict.banner')}</div>
    {#if tabs.length > 1}
      <div class="tabs" role="tablist">
        {#each tabs as v (v)}
          <button type="button" role="tab" class="tab" aria-selected={view === v} data-testid="diff-conflict-tab-{v}" onclick={() => selectView(v)}>{viewLabel(v)}</button>
        {/each}
      </div>
    {/if}
  {/if}

  {#if diff?.lfsPointer}
    <div class="banner" role="note" data-testid="diff-lfs-pointer-banner">{t('diff.lfs')}</div>
  {/if}

  {#if diff === null}
    {#if loadError}
      <div class="state" data-testid="diff-error">
        <p>{t('diff.error')}</p>
        <button type="button" class="btn" onclick={() => void load()}>{t('diff.retry')}</button>
      </div>
    {:else}
      <div class="state muted" data-testid="diff-loading">{t('diff.loading')}</div>
    {/if}
  {:else if diff.submodule}
    <div class="state" data-testid="diff-submodule-placeholder">
      {t('diff.submodule', {
        old: shortOid(diff.submodule.oldOid),
        new: shortOid(diff.submodule.newOid),
        state: t(diff.submodule.dirty ? 'diff.submodule.dirty' : 'diff.submodule.clean'),
      })}
    </div>
  {:else if diff.binary}
    <div class="state" data-testid="diff-binary-placeholder">{sizeText(diff)}</div>
  {:else if diff.tooLarge}
    <div class="state" data-testid="diff-large-placeholder" data-hard-limit={diff.tooLarge.hardLimit ? 'true' : undefined}>
      <strong>{t('diff.large.title')}</strong>
      <p>{t('diff.large.info', { size: formatBytes(diff.tooLarge.bytes), lines: diff.tooLarge.lines.toLocaleString('en-US') })}</p>
      {#if diff.tooLarge.hardLimit}
        <p class="muted">{t('diff.large.hard')}</p>
        <button type="button" class="btn" data-testid="diff-large-open-btn" onclick={editor}>{t('diff.openExternal')}</button>
      {:else}
        <button type="button" class="btn" data-testid="diff-large-load-btn" disabled={forcing} onclick={() => void loadAnyway()}>
          {forcing ? t('diff.large.loading') : t('diff.large.load')}
        </button>
      {/if}
    </div>
  {:else if layout && layout.rows.length > 0}
    <DiffLines
      {layout}
      {sourceKind}
      {canHunk}
      locked={op.busy}
      {focusedHunk}
      onfocushunk={(i) => (focusedHunk = i)}
      onhunk={(kind, i) => void hunk(kind, i)}
      resetKey={`${path}\u0000${effective.kind === 'conflict' ? view : ''}`}
    />
  {:else}
    <div class="state muted" data-testid="diff-empty">{conflictKind === 'both-deleted' ? t('diff.conflict.missing') : t(emptyKey)}</div>
  {/if}
</div>

<style>
  .viewer {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    background: var(--bg);
  }
  .head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 38px;
    padding: 0 8px 0 12px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-elev);
  }
  .chip {
    flex: none;
    padding: 0 6px;
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 11px;
    line-height: 18px;
  }
  .path {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .old,
  .arrow {
    color: var(--fg-muted);
  }
  .mode {
    flex: none;
    color: var(--fg-muted);
  }
  .stats {
    flex: none;
  }
  .stats .add {
    color: var(--success);
  }
  .stats .del {
    color: var(--danger);
  }
  .spacer {
    flex: 1;
  }
  .hbtn {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    font-size: 12px;
  }
  .hbtn:hover {
    background: var(--row-hover);
  }
  .banner {
    flex: none;
    padding: 6px 12px;
    font-size: 12px;
    color: var(--warn);
    background: var(--bg-elev);
    border-bottom: 1px solid var(--border);
  }
  .tabs {
    flex: none;
    display: flex;
    gap: 2px;
    padding: 4px 8px 0;
    border-bottom: 1px solid var(--border);
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
    background: var(--bg);
    font-weight: 600;
    margin-bottom: -1px;
  }
  .state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 24px;
    text-align: center;
  }
  .state p {
    margin: 0;
  }
</style>
