<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { op, reportError, session } = captureStores();
  // `discard-trash-panel`: drawer to the right of the graph, next to the reflog. The files that a discard (whole file, hunk
  // or lines) or a "take ours / theirs" threw away, newest first, each with a button that writes that version back into
  // the working tree. What a restore overwrites is saved to this list first, so a restore is never a loss either.
  import { onMount } from 'svelte';
  import { roving } from '$lib/actions/roving';
  import { commands } from '$lib/ipc/commands';
  import { onEvent } from '$lib/ipc/events';
  import type { DiscardedFile } from '$lib/ipc/types';

  import { t } from '$i18n/index';
  import RecoveryTabs from '../undo/RecoveryTabs.svelte';
  import Spinner from '$lib/components/ui/Spinner.svelte';
  import { restoreDiscarded } from './run';
  import { entryMeta, splitPath } from './trash-logic';

  let { close }: { close: () => void } = $props();

  let entries = $state.raw<DiscardedFile[]>([]);
  let loading = $state(false);
  let failed = $state(false);
  let seq = 0;

  // Same family as a discard: allowed while a merge or rebase is stopped (a conflicted file is just a file), not while a write runs.
  const blocked = $derived(op.blockReason('index'));

  async function load(): Promise<void> {
    const repoId = session.repoId;
    if (repoId === null) return;
    const gen = session.gen;
    const mine = ++seq;
    loading = entries.length === 0;
    try {
      const list = await commands.discardList({ repoId });
      if (mine === seq && session.isCurrent(gen)) {
        entries = list;
        failed = false;
      }
    } catch (e) {
      if (mine === seq) {
        failed = true;
        reportError(e, { command: 'discard_list', quiet: true });
      }
    } finally {
      if (mine === seq) loading = false;
    }
  }

  // A discard, a restore or an edit announces itself as a worktree or index change. Edits come in bursts: wait for a pause.
  let timer: ReturnType<typeof setTimeout> | undefined;
  function reloadSoon(): void {
    clearTimeout(timer);
    timer = setTimeout(() => void load(), 250);
  }

  onMount(() => {
    void load();
    const off = onEvent('repo:changed', (ev) => {
      if (ev.repoId === session.repoId && (ev.kinds.includes('worktree') || ev.kinds.includes('index'))) reloadSoon();
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  });

  async function restore(entry: DiscardedFile): Promise<void> {
    await restoreDiscarded([entry.id], [entry.path], () => void load(), session);
    await load();
  }
</script>

<div class="trash" id="recovery-panel" role="tabpanel" aria-labelledby="recovery-tab-discarded" data-testid="discard-trash-panel">
  <RecoveryTabs active="discard-trash-panel" {close} closeTestid="trash-close-btn" closeLabel={t('trash.close')} />

  {#if loading}
    <p class="state muted"><Spinner size={12} /> {t('trash.loading')}</p>
  {:else if failed && entries.length === 0}
    <p class="state" data-testid="trash-error">{t('trash.error')}</p>
  {:else if entries.length === 0}
    <div class="state" data-testid="trash-empty">
      <p>{t('trash.empty')}</p>
      <p class="muted">{t('trash.emptyHint')}</p>
    </div>
  {:else}
    <ul class="list" use:roving={'[data-roving]'}>
      {#each entries as entry (entry.id)}
        {@const { dir, name } = splitPath(entry.path)}
        <li class="row" data-testid="trash-item" data-id={entry.id} data-path={entry.path} data-source={entry.source}>
          <div class="info" title={entry.path}>
            <div class="line">
              <span class="name truncate" data-testid="trash-item-name">{name}</span>
              {#if dir}<span class="dir muted truncate">{dir}</span>{/if}
            </div>
            <span class="meta muted truncate" data-testid="trash-item-meta">{entryMeta(entry)}</span>
          </div>
          <button
            type="button"
            class="btn"
            data-roving
            data-testid="trash-item-restore-btn"
            disabled={blocked !== null}
            title={blocked ?? t('trash.restore.title')}
            aria-label={t('trash.restore.aria', { path: entry.path })}
            onclick={() => restore(entry)}
          >{t('trash.restore')}</button>
        </li>
      {/each}
    </ul>
    <p class="note muted">{t('trash.retention')}</p>
  {/if}
</div>

<style>
  .trash {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .state {
    padding: 12px;
    margin: 0;
  }
  .state p {
    margin: 0 0 6px;
  }
  .list {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
  }
  .row:hover {
    background: var(--row-hover);
  }
  .info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .line {
    display: flex;
    gap: 8px;
    min-width: 0;
  }
  .name {
    flex: 0 1 auto;
    min-width: 0;
    font-weight: 600;
  }
  .dir {
    flex: 1 1 0;
    min-width: 0;
    font-size: 12px;
    align-self: center;
  }
  .meta {
    font-size: 12px;
  }
  .note {
    flex: none;
    margin: 0;
    padding: 8px;
    font-size: 12px;
    border-top: 1px solid var(--border);
  }
</style>
