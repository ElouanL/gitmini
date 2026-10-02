<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { graph, ui } = captureStores();
  // Multi-commits panel (03, 09): "n commits selected", grouped buttons `multi-commit-cherry-pick-btn` /
  // `multi-commit-revert-btn` (registry actions `pick.cherry-pick` / `pick.revert`, domain flows), and with EXACTEMENT 2 commits the
  // list of files modified between them (`commit_details { oid: <newer>, against: <older> }`, diff `range` at click).
  import { actionContext, actionDisabledReason, getAction, runAction } from '$lib/actions/registry';
  import { formatDate, shortOid } from '$lib/format';

  import { t, tp } from '$i18n/index';
  import type { FileChange, GraphRow } from '$lib/ipc/types';
  import { orderPair } from './pair';
  import { DetailsLoader } from './details.svelte';
  import FileList from './FileList.svelte';

  const sel = $derived(graph.selection);
  const oids = $derived(sel.kind === 'commits' ? sel.oids : []);

  const loader = new DetailsLoader();

  /** Lines already loaded with selected commits (summary, date); missing if their page was released. */
  const rows = $derived.by(() => {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- recomputed by `$derived`, never mutated afterwards
    const m = new Map<string, GraphRow>();
    const want = new Set(oids);
    for (const p of graph.pages) for (const r of p.rows) if (r.kind === 'commit' && want.has(r.oid)) m.set(r.oid, r);
    return m;
  });

  /** The two commits ordered by rank of graph: oldest = largest row. */
  const pair = $derived(oids.length === 2 ? orderPair(oids[0]!, oids[1]!, (o) => graph.rowHints[o] ?? null) : null);

  $effect(() => {
    if (pair) loader.request(pair.newer, pair.older);
    else loader.request(null);
  });

  const ds = $derived(loader.state);
  const data = $derived(ds.status === 'ready' ? ds.data : null);
  let openedPath = $state<string | null>(null);

  function openFile(f: FileChange): void {
    if (!pair) return;
    openedPath = f.path;
    ui.openCenter('diff', { path: f.path, source: { kind: 'range', from: pair.older, to: pair.newer } });
  }

  const target = $derived({ menu: 'commit' as const, oid: sel.kind === 'commits' ? sel.anchor : '', oids });

  function reason(id: string): string | null {
    const def = getAction(id);
    if (!def) return t('graph.multi.unavailable');
    return actionDisabledReason(def, actionContext(target)) ?? null;
  }
  const pickOff = $derived(reason('pick.cherry-pick'));
  const revertOff = $derived(reason('pick.revert'));
</script>

<section class="panel" data-testid="multi-commit-panel" data-count={oids.length}>
  <header class="head">
    <h2 data-testid="multi-commit-title">{tp('graph.multi.title', oids.length)}</h2>
    <div class="actions">
      <button type="button" class="btn" data-testid="multi-commit-cherry-pick-btn" disabled={pickOff !== null} title={pickOff ?? undefined} onclick={() => void runAction('pick.cherry-pick', target)}>
        {t('graph.multi.cherryPick', { n: oids.length })}
      </button>
      <button type="button" class="btn" data-testid="multi-commit-revert-btn" disabled={revertOff !== null} title={revertOff ?? undefined} onclick={() => void runAction('pick.revert', target)}>
        {t('graph.multi.revert', { n: oids.length })}
      </button>
    </div>
  </header>

  <ul class="commits" data-testid="multi-commit-list">
    {#each oids as o (o)}
      {@const r = rows.get(o)}
      <li class="commit" data-testid="multi-commit-item" data-oid={o}>
        <code>{shortOid(o)}</code>
        <span class="summary truncate">{r ? r.summary : t('graph.multi.unknown')}</span>
        {#if r}<span class="muted when">{formatDate(r.time)}</span>{/if}
      </li>
    {/each}
  </ul>

  {#if pair}
    <div class="compare">
      <h3>{t('graph.multi.compare')}</h3>
      <p class="muted range">{t('graph.multi.compareHint', { from: shortOid(pair.older), to: shortOid(pair.newer) })}</p>
      {#if data}
        <FileList files={data.files} truncated={data.truncated} onopen={openFile} selectedPath={openedPath} />
      {:else if ds.status === 'error'}
        <div class="muted err" role="alert">{ds.error.message}</div>
      {:else}
        <div class="muted err">{t('graph.details.loading')}</div>
      {/if}
    </div>
  {/if}
</section>

<style>
  .panel { display: flex; flex-direction: column; height: 100%; overflow-y: auto; font-size: 13px; }
  .head { padding: 12px; border-bottom: 1px solid var(--border); }
  h2 { margin: 0 0 8px; font-size: 14px; }
  h3 { margin: 0; padding: 12px 12px 0; font-size: 13px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .commits { margin: 0; padding: 4px 0; list-style: none; border-bottom: 1px solid var(--border); }
  .commit { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 2px 12px; font-size: 12px; }
  .commit code { font-family: var(--font-mono); color: var(--fg-muted); }
  .when { font-size: 11px; white-space: nowrap; }
  .range { margin: 0; padding: 0 12px 4px; font-size: 12px; font-family: var(--font-mono); }
  .err { padding: 8px 12px; font-size: 12px; }
</style>
