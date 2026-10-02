<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { op, repo, status, wt } = captureStores();
  // Right panel when the line WIP is selected (03 "Right panel", 05): conflicts, not staged, staged,
  // commit form. Reads stores; the displayed state is always the last `StatusSnapshot` received (never optimistic).
  import { untrack } from 'svelte';

  import { t } from '$i18n/index';
  import CommitForm from '../commit-form/CommitForm.svelte';
  import FileSection from './FileSection.svelte';
  import { partition } from './list-model';

  const snapshot = $derived(status.snapshot);
  const lists = $derived(partition(snapshot?.files ?? []));
  const opKind = $derived(op.state?.kind ?? 'none');
  const head = $derived(repo.head);
  const loading = $derived(snapshot === null);

  // A conflict appears (CONFLICT, application of stash): the first file in conflict is selected (no diff opened on its own).
  let lastConflictKey = '';
  $effect(() => {
    const first = lists.conflicts[0]?.path ?? null;
    const key = first === null ? '' : `${opKind}:${first}`;
    if (key !== '' && key !== lastConflictKey && untrack(() => wt.selections.conflict.paths.size === 0)) {
      wt.select('conflict', { paths: new Set([first!]), anchor: first, focus: first });
    }
    lastConflictKey = key;
  });

  const ahead = $derived(snapshot?.ahead ?? null);
  const behind = $derived(snapshot?.behind ?? null);
  const upstream = $derived(snapshot?.upstream ?? null);
</script>

<div class="wt" data-testid="wt-panel">
  <div class="head">
    <span class="branch truncate" data-testid="wt-branch">{head?.detached ? t('wt.panel.branch.detached') : (head?.branch ?? '')}</span>
    {#if upstream !== null && ahead !== null && behind !== null}
      <span
        class="ab muted"
        data-testid="wt-ahead-behind"
        data-ahead={ahead}
        data-behind={behind}
        title={t('wt.panel.aheadBehind', { ahead, behind, upstream })}
      >
        ↑{ahead} ↓{behind}
      </span>
    {/if}
  </div>

  {#if lists.conflicts.length > 0}
    <FileSection side="conflict" files={lists.conflicts} {opKind} />
  {/if}
  <FileSection side="unstaged" files={lists.unstaged} {loading} />
  <FileSection side="staged" files={lists.staged} {loading} />

  {#if snapshot?.truncated}
    <div class="truncated" role="note" data-testid="wt-truncated-banner">{t('wt.truncated')}</div>
  {/if}

  <CommitForm />
</div>

<style>
  .wt {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    overflow-y: auto;
  }
  .head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 10px;
    border-bottom: 1px solid var(--border);
    font-weight: 600;
  }
  .branch {
    min-width: 0;
  }
  .ab {
    flex: none;
    font: 12px var(--font-mono);
  }
  .truncated {
    flex: none;
    padding: 6px 10px;
    font-size: 12px;
    color: var(--warn);
    background: var(--bg-elev);
    border-bottom: 1px solid var(--border);
  }
</style>
