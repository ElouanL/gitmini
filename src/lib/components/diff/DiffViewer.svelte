<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { reportError: handleError, op, runWrite, session, status, ui } = captureStores();
  // Unified diff Viewer (05 "diff Viewer"), central view `diff` (`ui.openCenter('diff', { path, source })`).
  // Sources : unstaged, staged, commit (parent en base 1), range, stash, conflict (markers | ours | theirs).
  // Refreshing: `repo:changed { worktree | index | head }` restarts `diff_file` of the displayed file (mutable sources only).
  // Context (DIFF-05): `diff.contextLines` (Settings, or the header's select) sets how many unchanged lines surround a change;
  // changing it rereads the diff. The hunks, their indexes and the hash depend on it, so the hunk actions name the value the
  // diff on screen was read with.
  import { onMount, untrack } from 'svelte';
  import { commands } from '$lib/ipc/commands';
  import type { AppError, ConflictView, DiffSource, FileDiff } from '$lib/ipc/types';
  import type { ConflictSide } from '$lib/ipc/commands';
  import { isTextInput } from '$lib/actions/shortcuts';
  import { confirmAction } from '$lib/dialogs/confirm';

  import { onEvent } from '$lib/ipc/events';
  import { DIFF_CONTEXT_CHOICES, normalizeDiffContext, type DiffContextSetting } from '$lib/ipc/settings-types';
  import { app } from '$lib/stores/app.svelte';
  import Icon from '$lib/components/ui/Icon.svelte';
  import { diffHistoryPath, openFileHistory } from '../flows/history/open';

  import { createCoalescer } from '$lib/stores/schedule';

  import { t, tp } from '$i18n/index';
  import { announceDiscard } from '../flows/trash/announce';
  import { openInEditor, resolveWithSide } from '../wt/actions';
  import RowIcon from '../wt/RowIcon.svelte';
  import { conflictSideLabel, conflictTabs, resolvableSides, resolveSideText, resolveSideTitle, sideOutcome } from './conflict';
  import { firstConflictLine, formatBytes, layoutDiff, modeChange } from './diff-layout';
  import { eventAffectsDiff, hunkActionsAllowed, sameDiff } from './diff-state';
  import DiffLines from './DiffLines.svelte';
  import { extendSelection, pickLine, selectedLines, type LineSelection, type PickMods } from './line-select';

  interface Props {
    path: string;
    source: DiffSource;
    /** Shown inside another view (the file history): no close button, no links to that view. */
    embedded?: boolean;
  }

  // The spaces around the arrow are part of the text ("old.txt → new.txt").
  const ARROW = ' → ';
  let { path, source, embedded = false }: Props = $props();

  // Conflict View (Tabs): starts from the one requested in each new file.
  let view = $state<ConflictView>('markers');
  let diff = $state.raw<FileDiff | null>(null);
  let loading = $state(false);
  let forcing = $state(false);
  let loadError = $state.raw<AppError | null>(null);
  let focusedHunk = $state<number | null>(null);
  // Lines picked in one hunk (STAGE-10); dropped whenever the diff behind the indexes changes.
  let lineSel = $state.raw<LineSelection | null>(null);
  let rows = $state<{ reveal(row: number): void }>();
  let forced = false;
  let seq = 0;
  // `diff.contextLines` the diff on screen was read with (what the hunk actions must name).
  let readWith: DiffContextSetting = normalizeDiffContext(app.get('diff.contextLines'));

  const contextLines = $derived(normalizeDiffContext(app.get('diff.contextLines')));
  const sourceKind = $derived(source.kind);
  const effective = $derived<DiffSource>(source.kind === 'conflict' ? { kind: 'conflict', view } : source);
  const mutable = $derived(sourceKind === 'unstaged' || sourceKind === 'staged' || sourceKind === 'conflict');

  const entry = $derived(status.files.find((f) => f.path === path) ?? null);
  const conflictKind = $derived(entry?.conflict ?? null);
  const tabs = $derived(source.kind === 'conflict' ? conflictTabs(conflictKind) : []);
  // "Take ours / theirs": not for a submodule or a non-UTF-8 path (read only), nor when neither side has a version.
  const sides = $derived(source.kind === 'conflict' && entry !== null && !entry.submodule && !entry.nonUtf8 ? resolvableSides(conflictKind) : []);

  const layout = $derived(diff && !diff.binary && !diff.tooLarge && !diff.submodule ? layoutDiff(diff, { markers: source.kind === 'conflict' && view === 'markers' }) : null);
  const canHunk = $derived(hunkActionsAllowed(diff, sourceKind, entry?.nonUtf8 === true));

  async function load(opts: { silent?: boolean } = {}): Promise<void> {
    const repoId = session.repoId;
    if (repoId === null) return;
    const mine = ++seq;
    const gen = session.gen;
    const context = contextLines;
    if (!opts.silent) loading = true;
    try {
      const d = await commands.diffFile({ repoId, path, source: effective, contextLines: context, ...(forced ? { force: true } : {}) });
      if (mine !== seq || !session.isCurrent(gen)) return;
      loadError = null;
      // Another context size merges or splits the hunks: their numbers no longer name the same ones.
      const resized = context !== readWith;
      readWith = context;
      if (!sameDiff(diff, d)) {
        diff = d;
        lineSel = null;
        if (resized || (focusedHunk !== null && focusedHunk >= d.hunks.length)) focusedHunk = null;
      }
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
      lineSel = null;
      diff = null;
      loadError = null;
      void load();
    });
  });

  // Another context size: the diff is read again (the old one stays on screen until the new one arrives). The first run is the
  // initial load's business.
  let lastContext: DiffContextSetting | null = null;
  $effect(() => {
    const c = contextLines;
    if (lastContext === null) {
      lastContext = c;
      return;
    }
    if (c === lastContext) return;
    lastContext = c;
    untrack(() => void load());
  });

  // Changement d'onglet de conflit.
  function selectView(v: ConflictView): void {
    if (v === view) return;
    view = v;
    diff = null;
    focusedHunk = null;
    lineSel = null;
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

  // "Hunks: the backend reconstructs the patch; only the displayed diff hash, the hunk index and, to act on some of its lines, their
  // indexes are sent (05 "Stage a hunk", STAGE-10).
  async function hunk(kind: 'stage' | 'unstage' | 'discard', index: number, picked?: number[]): Promise<void> {
    const d = diff;
    const repoId = session.repoId;
    if (!d || repoId === null) return;
    if (kind === 'discard') {
      const ok = await confirmAction({
        action: 'discard',
        danger: true,
        title: picked ? t('diff.lines.discard.title') : t('diff.hunk.discard.title'),
        message: picked ? tp('diff.lines.discard.message', picked.length, { path: d.path }) : t('diff.hunk.discard.message', { path: d.path }),
        confirmLabel: picked ? tp('diff.lines.discard', picked.length) : t('diff.hunk.discard.confirm'),
      }, session);
      if (!ok) return;
    }
    const args = { repoId, path: d.path, diffHash: d.hash, hunkIndex: index, contextLines: readWith, ...(picked ? { lines: picked } : {}) };
    const what = picked ? 'Lines' : 'Hunk';
    const label = t(`diff.op.${kind}${what}`);
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
      lineSel = null;
      if (kind === 'discard') announceDiscard({ kind: 'hunk', path: d.path }, session);
      await load({ silent: true });
    }
  }

  // Selected lines: the actions of the hunk header and the keys act on them.
  function pick(hunkIndex: number, line: number, mods: PickMods): void {
    if (!diff || !canHunk) return;
    lineSel = pickLine(lineSel, diff.hunks, hunkIndex, line, mods);
    focusedHunk = hunkIndex;
  }

  function actOnLines(kind: 'stage' | 'unstage' | 'discard'): void {
    const sel = lineSel;
    if (sel) void hunk(kind, sel.hunk, selectedLines(sel));
  }

  function extend(delta: 1 | -1): void {
    if (!diff) return;
    const next = extendSelection(lineSel, diff.hunks, focusedHunk ?? 0, delta);
    if (next === lineSel) return;
    lineSel = next;
    if (!next) return;
    focusedHunk = next.hunk;
    const row = layout?.hunkRows[next.hunk];
    if (row !== undefined) rows?.reveal(row + 1 + next.focus);
  }

  function onkeydown(e: KeyboardEvent): void {
    // Keys typed in the header's select (`s` while looking for an option) are its own, not the hunk's.
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || !canHunk || isTextInput(e.target)) return;
    // Selection: Shift+Arrow picks / extends, Escape drops it (Escape without selection closes the diff, globally).
    if (e.shiftKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      extend(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.shiftKey) return;
    if (e.key === 'Escape' && lineSel) {
      e.preventDefault();
      lineSel = null;
      return;
    }
    if (op.busy) return;
    // With lines selected the keys act on them; otherwise on the focused hunk.
    if (lineSel) {
      if (e.key === 's' && sourceKind === 'unstaged') {
        e.preventDefault();
        actOnLines('stage');
      } else if (e.key === 'u' && sourceKind === 'staged') {
        e.preventDefault();
        actOnLines('unstage');
      } else if (e.key === 'Delete' && sourceKind === 'unstaged') {
        e.preventDefault();
        actOnLines('discard');
      }
      return;
    }
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
  // Text hunks with a context to size (not a placeholder, not the conflict file shown as is).
  const hasHunks = $derived(diff !== null && diff.hunks.length > 0 && !diff.binary && !diff.tooLarge && !diff.submodule && !(source.kind === 'conflict' && view === 'markers'));
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
    return v === 'markers' ? t('diff.conflict.tab.markers') : conflictSideLabel(v, op.state);
  }

  function take(side: ConflictSide): void {
    void resolveWithSide([path], side, session);
  }

  // The name the history is read under (the old name of a staged rename, as in the file menus); `null`: not committed yet.
  const historyPath = $derived(diffHistoryPath(source.kind, path, entry));

  /** The file's history (and blame) starts at the commit being viewed, else at HEAD. */
  function history(mode: 'changes' | 'blame'): void {
    if (historyPath !== null) openFileHistory(historyPath, { rev: source.kind === 'commit' ? source.oid : null, mode });
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
    {#if diff && hasHunks}
      <span class="stats mono" data-testid="diff-stats"><span class="add">+{diff.stats.added}</span> <span class="del">−{diff.stats.removed}</span></span>
    {/if}
    <span class="spacer"></span>
    {#if hasHunks}
      <label class="ctx" title={t('diff.context.title')}>
        <span class="muted">{t('diff.context')}</span>
        <select
          class="select ctx-select"
          data-testid="diff-context-select"
          value={String(contextLines)}
          onchange={(e) => void app.set('diff.contextLines', Number(e.currentTarget.value) as DiffContextSetting)}
        >
          {#each DIFF_CONTEXT_CHOICES as n (n)}
            <option value={String(n)}>{tp('diff.context.option', n)}</option>
          {/each}
        </select>
      </label>
    {/if}
    {#if !embedded && sourceKind !== 'stash' && historyPath !== null}
      <button type="button" class="hbtn" data-testid="diff-history-btn" title={t('history.diff.history.title')} onclick={() => history('changes')}>
        <Icon name="history" size={12} />{t('history.diff.history')}
      </button>
      {#if diff && !diff.binary && !diff.submodule}
        <button type="button" class="hbtn" data-testid="diff-blame-btn" title={t('history.diff.blame.title')} onclick={() => history('blame')}>
          {t('history.diff.blame')}
        </button>
      {/if}
    {/if}
    {#if canOpenEditor}
      <button type="button" class="hbtn" data-testid="diff-open-external-btn" onclick={editor}>
        <RowIcon name="external" size={12} />{t('diff.openExternal')}
      </button>
    {/if}
    {#if !embedded}
      <button type="button" class="icon-btn" data-testid="diff-close-btn" title={t('diff.close')} aria-label={t('diff.close')} onclick={() => ui.closeCenter()}>
        <RowIcon name="close" size={14} />
      </button>
    {/if}
  </header>

  <span class="sr-only" role="status" data-testid="diff-lines-status">{lineSel ? tp('diff.lines.selected', lineSel.lines.size) : ''}</span>
  <span class="sr-only" role="status" data-testid="diff-context-status">{hasHunks ? tp('diff.context.status', contextLines) : ''}</span>

  {#if source.kind === 'conflict'}
    <div class="banner" role="note" data-testid="diff-conflict-banner">{t('diff.conflict.banner')}</div>
    {#if sides.length > 0}
      <div class="resolve" role="group" aria-label={t('wt.resolve.group')} data-testid="diff-conflict-resolve">
        {#each sides as s (s)}
          <button
            type="button"
            class="hbtn"
            data-testid="diff-conflict-take-{s}-btn"
            data-outcome={sideOutcome(conflictKind, s)}
            title={resolveSideTitle(conflictKind, s, op.state)}
            disabled={op.busy}
            onclick={() => take(s)}
          >
            {resolveSideText(s, op.state)}
          </button>
        {/each}
      </div>
    {/if}
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
      bind:this={rows}
      {layout}
      {sourceKind}
      {canHunk}
      locked={op.busy}
      {focusedHunk}
      onfocushunk={(i) => (focusedHunk = i)}
      onhunk={(kind, i) => void hunk(kind, i)}
      selection={lineSel}
      onpick={pick}
      onlines={actOnLines}
      onclear={() => (lineSel = null)}
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
  .ctx {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
  }
  .ctx-select {
    width: auto;
    height: 24px;
    padding-top: 0;
    padding-bottom: 0;
    font-size: 12px;
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
  .hbtn:hover:not(:disabled) {
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
  .resolve {
    flex: none;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--border);
  }
  .hbtn:disabled {
    opacity: 0.45;
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
