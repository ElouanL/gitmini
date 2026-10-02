<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { reportError, graph, refs, session } = captureStores();
  // `reflog-panel` (11 §UI): drawer to the right of the graph. Last 50 entries of HEAD or a local branch (leader),
  // from the most recent to the oldest. Click = selection of the commit if it is loaded in the graph; buttons « Create branch
  // here" (`branch-create-dialog`, startPoint = oid) and "Detached Checkout" (without confirmation).
  import { onMount } from 'svelte';
  import { checkoutTarget } from '$lib/actions/checkout';
  import { roving } from '$lib/actions/roving';
  import { openDialog } from '$lib/dialogs/registry';

  import { formatRelative, shortOid } from '$lib/format';
  import { commands } from '$lib/ipc/commands';
  import { onEvent } from '$lib/ipc/events';
  import type { ReflogEntry } from '$lib/ipc/types';

  import { t } from '$i18n/index';
  import Icon from '$lib/components/ui/Icon.svelte';
  import Spinner from '$lib/components/ui/Spinner.svelte';
  import { reflogRefLabel } from './reflog';

  let { close }: { close: () => void } = $props();

  /** `HEAD` or the short name of a local branch. */
  let ref = $state('HEAD');
  let entries = $state.raw<ReflogEntry[]>([]);
  let loading = $state(false);
  let failed = $state(false);
  let seq = 0;

  const branches = $derived((refs.snapshot?.local ?? []).map((b) => b.name).sort((a, b) => a.localeCompare(b)));

  async function load(): Promise<void> {
    const repoId = session.repoId;
    if (repoId === null) return;
    const gen = session.gen;
    const mine = ++seq;
    loading = entries.length === 0;
    try {
      const list = await commands.reflogList({ repoId, ref, limit: 50 });
      if (mine === seq && session.isCurrent(gen)) {
        entries = list;
        failed = false;
      }
    } catch (e) {
      if (mine === seq) {
        failed = true;
        reportError(e, { command: 'reflog_list', quiet: true });
      }
    } finally {
      if (mine === seq) loading = false;
    }
  }

  onMount(() => {
    void load();
    // The refrog changes with each shift of HEAD or ref.
    return onEvent('repo:changed', (ev) => {
      if (ev.repoId === session.repoId && (ev.kinds.includes('head') || ev.kinds.includes('refs'))) void load();
    });
  });

  function selectRef(e: Event): void {
    ref = (e.currentTarget as HTMLSelectElement).value;
    entries = [];
    void load();
  }

  function select(entry: ReflogEntry): void {
    if (graph.hasLoaded(entry.oid)) void graph.reveal(entry.oid);
  }

  function createBranch(entry: ReflogEntry): void {
    void openDialog('branch-create-dialog', { startPoint: entry.oid });
  }

  function checkout(entry: ReflogEntry): void {
    void checkoutTarget({ kind: 'detached', oid: entry.oid }, session);
  }
</script>

<section class="reflog" data-testid="reflog-panel" aria-label={t('reflog.title')}>
  <header>
    <h2>{t('reflog.title')}</h2>
    <select class="select" data-testid="reflog-ref-select" aria-label={t('reflog.ref')} value={ref} onchange={selectRef}>
      <option value="HEAD">{t('reflog.ref.head')}</option>
      {#each branches as b (b)}
        <option value={b}>{b}</option>
      {/each}
    </select>
    <button type="button" class="icon-btn" data-testid="reflog-close-btn" aria-label={t('reflog.close')} title={t('reflog.close')} onclick={close}>
      <Icon name="x" size={14} />
    </button>
  </header>

  {#if loading}
    <p class="state muted"><Spinner size={12} /> {t('reflog.loading')}</p>
  {:else if failed && entries.length === 0}
    <p class="state" data-testid="reflog-error">{t('reflog.error')}</p>
  {:else if entries.length === 0}
    <p class="state muted" data-testid="reflog-empty">{t('reflog.empty')}</p>
  {:else}
    <ul class="list" use:roving={'[data-roving]'}>
      {#each entries as entry (entry.index + ':' + entry.oid)}
        <li class="row" data-testid="reflog-item" data-index={entry.index} data-oid={entry.oid}>
          <button type="button" class="main" data-roving title={entry.message} onclick={() => select(entry)}>
            <span class="head mono">{reflogRefLabel(ref, entry.index)}</span>
            <span class="sha mono">{shortOid(entry.oid)}</span>
            <span class="msg truncate">{entry.message}</span>
            <span class="date muted">{formatRelative(entry.time)}</span>
          </button>
          <button type="button" class="icon-btn" data-testid="reflog-item-create-branch-btn" title={t('reflog.createBranch')} aria-label={t('reflog.createBranch')} onclick={() => createBranch(entry)}>
            <Icon name="branch" size={14} />
          </button>
          <button type="button" class="icon-btn" data-testid="reflog-item-checkout-btn" title={t('reflog.checkout')} aria-label={t('reflog.checkout')} onclick={() => checkout(entry)}>
            <Icon name="commit" size={14} />
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .reflog {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px;
    border-bottom: 1px solid var(--border);
  }
  h2 {
    font-size: 13px;
  }
  .select {
    flex: 1;
    min-width: 0;
  }
  .state {
    padding: 12px;
    margin: 0;
  }
  .list {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 2px;
    padding-right: 4px;
  }
  .row:hover {
    background: var(--row-hover);
  }
  .main {
    display: grid;
    grid-template-columns: auto auto 1fr;
    grid-template-areas: 'head sha date' 'msg msg msg';
    column-gap: 8px;
    flex: 1;
    min-width: 0;
    padding: 4px 8px;
    border: 0;
    background: transparent;
    text-align: left;
  }
  .head {
    grid-area: head;
    color: var(--fg-muted);
  }
  .sha {
    grid-area: sha;
    color: var(--accent);
  }
  .date {
    grid-area: date;
    justify-self: end;
    font-size: 12px;
  }
  .msg {
    grid-area: msg;
  }
</style>
