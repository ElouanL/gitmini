<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { reportError, graph, op, refs, session, ui } = captureStores();
  // `stash-detail-panel` (08 §Detail of a stash): message, branch of origin, date, base; files by part (modified / staged /
  // Untracked, `stash_show`); a click on a file opens its diff (source `stash`) in the central area; Apply, Pop, Drop,
  // Branch. The panel has no props: it reads the graph selection (`graph.selection.kind === 'stash'`).
  import { untrack } from 'svelte';

  import { formatDate, shortOid } from '$lib/format';
  import { commands } from '$lib/ipc/commands';
  import type { FileChange, StashFiles } from '$lib/ipc/types';
  import { openDialog } from '$lib/dialogs/registry';

  import { t } from '$i18n/index';
  import Spinner from '$lib/components/ui/Spinner.svelte';
  import { applyStash, dropStash } from './stash-ops';
  import { stashUiFor } from './stash-state.svelte';
  const stashUi = stashUiFor(session);
  import { nonEmptyParts, stashRef, stashSummary, type StashPart } from './stash-text';

  const sel = $derived(graph.selection);
  const stash = $derived(sel.kind === 'stash' ? (refs.stashes.find((s) => s.oid === sel.oid) ?? null) : null);
  const oid = $derived(stash?.oid ?? null);

  let files = $state.raw<StashFiles | null>(null);
  let filesFailed = $state(false);
  let activeKey = $state<string | null>(null);

  // `stash_show` every time you change stash (identity = oid: a renumbering does not reload anything).
  $effect(() => {
    const current = oid;
    untrack(() => {
      files = null;
      filesFailed = false;
      activeKey = null;
      if (stashUi.indexConflict && stashUi.indexConflict.oid !== current) stashUi.indexConflict = null;
    });
    const repoId = session.repoId;
    if (!current || repoId === null) return;
    let cancelled = false;
    const gen = session.gen;
    void commands
      .stashShow({ repoId, oid: current })
      .then((f) => {
        if (!cancelled && session.isCurrent(gen)) files = f;
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        filesFailed = true;
        // The stash disappeared out of the app: the list is reread (NOT_FOUND { what: "stash" }), without toast.
        reportError(e, { command: 'stash_show', quiet: true });
        void refs.reloadStashes();
      });
    return () => {
      cancelled = true;
    };
  });

  const parts = $derived(files ? nonEmptyParts(files) : []);
  const indexConflict = $derived(stashUi.indexConflict && stashUi.indexConflict.oid === oid ? stashUi.indexConflict : null);

  // apply / pop / branch refused during a state operation; drop remains allowed (does not touch HEAD or index).
  const writeBlock = $derived(op.blockReason('write'));
  const dropBlock = $derived(op.blockReason('index'));

  function openDiff(part: StashPart, file: FileChange): void {
    if (!oid) return;
    activeKey = `${part}:${file.path}`;
    ui.openCenter('diff', { path: file.path, source: { kind: 'stash', oid, part } });
  }

  function badge(change: FileChange['change']): string {
    switch (change) {
      case 'added':
      case 'untracked':
        return 'A';
      case 'deleted':
        return 'D';
      case 'renamed':
        return 'R';
      case 'copied':
        return 'C';
      case 'typechange':
        return 'T';
      default:
        return 'M';
    }
  }
</script>

<section class="stash-panel" data-testid="stash-detail-panel" aria-label={t('stash.panel.label')}>
  {#if !stash}
    <p class="gone muted" data-testid="stash-detail-gone">{t('stash.error.gone')}</p>
  {:else}
    <header>
      <h2 class="title" title={stash.message}>{stashRef(stash.index)} · {stashSummary(stash.message)}</h2>
      <dl class="meta">
        <dt>{t('stash.panel.branch')}</dt>
        <dd>{stash.branch ?? t('stash.panel.noBranch')}</dd>
        <dt>{t('stash.panel.date')}</dt>
        <dd>{formatDate(stash.time)}</dd>
        <dt>{t('stash.panel.base')}</dt>
        <dd class="mono">{shortOid(stash.baseOid)}</dd>
      </dl>
    </header>

    <div class="actions">
      <button type="button" class="btn" data-testid="stash-apply-btn" disabled={writeBlock !== null} title={writeBlock ?? undefined} onclick={() => void applyStash('apply', stash, stashUi.restoreIndex)}>{t('stash.apply')}</button>
      <button type="button" class="btn" data-testid="stash-pop-btn" disabled={writeBlock !== null} title={writeBlock ?? undefined} onclick={() => void applyStash('pop', stash, stashUi.restoreIndex)}>{t('stash.pop')}</button>
      <button type="button" class="btn" data-testid="stash-branch-btn" disabled={writeBlock !== null} title={writeBlock ?? undefined} onclick={() => void openDialog('stash-branch-dialog', { stash })}>{t('stash.branch')}</button>
      <button type="button" class="btn" data-testid="stash-drop-btn" disabled={dropBlock !== null} title={dropBlock ?? undefined} onclick={() => void dropStash(stash)}>{t('stash.drop')}</button>
    </div>
    <label class="checkbox restore">
      <input type="checkbox" data-testid="stash-restore-index-checkbox" bind:checked={stashUi.restoreIndex} />
      {t('stash.restoreIndex')}
    </label>
    {#if indexConflict}
      <div class="index-conflict" role="alert" data-testid="stash-index-conflict">
        <span>{t('stash.error.INDEX_CONFLICT')}</span>
        <button type="button" class="btn" data-testid="stash-retry-without-index-btn" disabled={writeBlock !== null} onclick={() => void applyStash(indexConflict.kind, stash, false)}>{t('stash.retryWithoutIndex')}</button>
      </div>
    {/if}

    <div class="files">
      {#if filesFailed}
        <p class="muted state">{t('stash.panel.filesError')}</p>
      {:else if !files}
        <p class="muted state"><Spinner size={12} /> {t('stash.panel.loading')}</p>
      {:else if parts.length === 0}
        <p class="muted state">{t('stash.panel.noFiles')}</p>
      {:else}
        {#each parts as part (part)}
          <h3 class="group" data-part={part}>{t(`stash.group.${part}`)} <span class="count">({files[part].length})</span></h3>
          <ul>
            {#each files[part] as file (part + ':' + file.path)}
              <li>
                <button
                  type="button"
                  class="file"
                  class:active={activeKey === `${part}:${file.path}`}
                  data-testid="stash-detail-file-item"
                  data-part={part}
                  data-path={file.path}
                  data-change={file.change}
                  title={file.path}
                  onclick={() => openDiff(part, file)}
                >
                  <span class="badge" data-change={file.change}>{badge(file.change)}</span>
                  <span class="path truncate">{file.path}</span>
                  {#if file.additions !== null || file.deletions !== null}
                    <span class="stat mono"><span class="add">+{file.additions ?? 0}</span> <span class="del">−{file.deletions ?? 0}</span></span>
                  {/if}
                </button>
              </li>
            {/each}
          </ul>
        {/each}
      {/if}
    </div>
  {/if}
</section>

<style>
  .stash-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    overflow: auto;
    padding: 12px;
    gap: 10px;
  }
  .gone {
    margin: 0;
    padding: 12px 0;
    text-align: center;
  }
  .title {
    font-size: 14px;
    word-break: break-word;
  }
  .meta {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 12px;
    margin: 6px 0 0;
    font-size: 12px;
  }
  dt {
    color: var(--fg-muted);
  }
  dd {
    margin: 0;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .restore {
    font-size: 12px;
  }
  .index-conflict {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    padding: 8px;
    border: 1px solid var(--warn);
    border-radius: var(--radius-sm);
  }
  .files {
    min-height: 0;
  }
  .state {
    margin: 0;
    padding: 8px 0;
  }
  .group {
    margin: 10px 0 2px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fg-muted);
  }
  .count {
    font-weight: 400;
    letter-spacing: 0;
  }
  .file {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: var(--row-height);
    padding: 0 6px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    text-align: left;
  }
  .file:hover {
    background: var(--row-hover);
  }
  .file.active {
    background: var(--row-selected);
  }
  .badge {
    flex: none;
    width: 16px;
    text-align: center;
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 700;
    color: var(--warn);
  }
  .badge[data-change='added'],
  .badge[data-change='untracked'] {
    color: var(--success);
  }
  .badge[data-change='deleted'] {
    color: var(--danger);
  }
  .path {
    flex: 1;
    min-width: 0;
  }
  .stat {
    flex: none;
    font-size: 11px;
  }
  .add {
    color: var(--success);
  }
  .del {
    color: var(--danger);
  }
</style>
