<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { graph, repo, ui } = captureStores();
  // Right panel of a selected commit (03): header (SHA copyable, author, dates, clickable parents), full message,
  // file list (`commit_details`). Clicking on a file opens `diff_file` in the central view `diff` (component of the
  // domain working tree): `ui.openCenter('diff', { path, source })`. For a merge, `commit-details-parent-select` chooses the parent.
  import { untrack } from 'svelte';
  import { copyText } from '$lib/clipboard';
  import { formatDate, shortOid } from '$lib/format';

  import { t } from '$i18n/index';
  import type { CommitDetails, FileChange } from '$lib/ipc/types';
  import Icon from '../ui/Icon.svelte';
  import Spinner from '../ui/Spinner.svelte';
  import { DetailsLoader } from './details.svelte';
  import FileList from './FileList.svelte';

  const loader = new DetailsLoader((oid) => {
    // The commit no longer exists (rewritten history): back to HEAD (03 "Persistent Selection").
    const head = repo.head?.oid ?? null;
    if (graph.singleCommitOid === oid) {
      if (head && head !== oid) void graph.reveal(head);
      else graph.clearSelection();
    }
  });

  const oid = $derived(graph.singleCommitOid);
  /** Parent (1-based) serving as the basis for a merge file list. */
  let parentN = $state(1);
  let openedPath = $state<string | null>(null);
  /** Last detail received: it remains displayed (discontinued) during loading of the next, without flashing in fast navigation. */
  let shown = $state.raw<CommitDetails | null>(null);

  // A new selection goes back to the parent 1.
  $effect(() => {
    void oid;
    parentN = 1;
    openedPath = null;
  });

  // Against the first default parent (`against` absent); against the n parent of a merge otherwise (parents known after the first reading).
  $effect(() => {
    const o = oid;
    const n = parentN;
    const against = untrack(() => {
      const s = loader.state;
      return n > 1 && s.status === 'ready' ? (s.data.parents[n - 1] ?? null) : null;
    });
    loader.request(o, against);
  });

  $effect(() => {
    const s = loader.state;
    if (s.status === 'ready') shown = s.data;
    else if (s.status === 'idle') shown = null;
  });

  const ds = $derived(loader.state);
  const data = $derived(shown);
  const loading = $derived(ds.status === 'loading');

  function openFile(f: FileChange): void {
    if (!data) return;
    openedPath = f.path;
    ui.openCenter('diff', { path: f.path, source: { kind: 'commit', oid: data.oid, parent: parentN > 1 ? parentN : null } });
  }

  const author = $derived(data?.author);
  const committer = $derived(data?.committer);
  const sameSignature = $derived(!!author && !!committer && author.name === committer.name && author.email === committer.email && author.time === committer.time);
  const lines = $derived.by(() => {
    const m = data?.message ?? '';
    const i = m.indexOf('\n');
    return i < 0 ? { title: m, body: '' } : { title: m.slice(0, i), body: m.slice(i + 1).replace(/^\n+/, '').trimEnd() };
  });
</script>

<section class="panel" class:loading data-testid="commit-details-panel" data-oid={oid ?? ''} data-status={ds.status} aria-busy={loading} aria-label={t('graph.details.sha')}>
  {#if ds.status === 'error'}
    <div class="state" role="alert">
      <p>{t('graph.details.error')}</p>
      <p class="muted">{ds.error.message}</p>
      <button type="button" class="btn" data-testid="commit-details-retry-btn" onclick={() => loader.retry()}>{t('graph.details.retry')}</button>
    </div>
  {:else if !data}
    <div class="state muted" data-testid="commit-details-loading"><Spinner size={14} /> <span>{t('graph.details.loading')}</span></div>
  {:else}
    <header class="head">
      <h2 class="title" data-testid="commit-details-title">{lines.title || t('graph.details.noMessage')}</h2>
      <div class="sha-row">
        <code class="sha" data-testid="commit-details-sha">{data.oid}</code>
        <button type="button" class="icon-btn" data-testid="commit-details-copy-sha-btn" title={t('graph.details.copySha')} aria-label={t('graph.details.copySha')} onclick={() => void copyText(data.oid)}>
          <Icon name="copy" size={14} />
        </button>
      </div>
      <dl class="meta">
        <dt>{t('graph.details.author')}</dt>
        <dd data-testid="commit-details-author">
          <span class="who">{author?.name}</span> <span class="muted">&lt;{author?.email}&gt;</span>
          <span class="muted date" data-testid="commit-details-date">{author ? formatDate(author.time) : ''}</span>
        </dd>
        {#if !sameSignature && committer}
          <dt>{t('graph.details.committer')}</dt>
          <dd data-testid="commit-details-committer">
            <span class="who">{committer.name}</span> <span class="muted">&lt;{committer.email}&gt;</span>
            <span class="muted date">{formatDate(committer.time)}</span>
          </dd>
        {/if}
        <dt>{t('graph.details.parents')}</dt>
        <dd data-testid="commit-details-parents">
          {#each data.parents as p, i (p)}
            <button type="button" class="link" data-testid="commit-details-parent" data-oid={p} title={t('graph.details.parent', { n: i + 1 })} onclick={() => void graph.reveal(p)}>{shortOid(p)}</button>
          {:else}
            <span class="muted">{t('graph.details.noParent')}</span>
          {/each}
          {#if data.parents.length > 1}
            <label class="parent-select">
              <span class="sr-only">{t('graph.details.parentSelect')}</span>
              <select class="select" data-testid="commit-details-parent-select" bind:value={parentN} aria-label={t('graph.details.parentSelect')}>
                {#each data.parents as p, i (p)}
                  <option value={i + 1}>{t('graph.details.parentOf', { n: i + 1, sha: shortOid(p) })}</option>
                {/each}
              </select>
            </label>
          {/if}
        </dd>
      </dl>
      {#if lines.body}
        <pre class="body" data-testid="commit-details-message">{lines.body}</pre>
      {/if}
    </header>
    <div class="list">
      <FileList files={data.files} truncated={data.truncated} onopen={openFile} selectedPath={openedPath} />
    </div>
  {/if}
</section>

<style>
  .panel { display: flex; flex-direction: column; height: 100%; overflow-y: auto; font-size: 13px; }
  .panel.loading { opacity: 0.6; }
  .state { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 24px 16px; text-align: center; }
  .head { padding: 12px 12px 8px; border-bottom: 1px solid var(--border); }
  .title { margin: 0 0 6px; font-size: 14px; line-height: 1.35; word-break: break-word; }
  .sha-row { display: flex; align-items: center; gap: 4px; margin-bottom: 8px; }
  .sha { font-family: var(--font-mono); font-size: 11px; color: var(--fg-muted); word-break: break-all; }
  .meta { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 12px; margin: 0; }
  dt { color: var(--fg-muted); font-size: 12px; }
  dd { margin: 0; min-width: 0; word-break: break-word; }
  .who { font-weight: 600; }
  .date { display: block; font-size: 12px; }
  .link { padding: 0 4px; border: 0; background: transparent; color: var(--accent); font-family: var(--font-mono); font-size: 12px; text-decoration: underline; }
  .parent-select { display: block; margin-top: 4px; }
  .body { margin: 10px 0 0; padding: 8px; max-height: 220px; overflow: auto; border-radius: var(--radius-sm); background: var(--bg-sunken); font: inherit; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
  .list { flex: 1; min-height: 0; }
</style>
