<script lang="ts">
  // List of files of a commit or two commits (03 "Right hand panel") : `commit-details-file-item` (`data-path`,
  // `data-change`), "... truncated list" beyond 2,000 files. One click opens the diff file in the central area.
  import { t, tp } from '$i18n/index';
  import type { FileChange } from '$lib/ipc/types';

  let {
    files, truncated = false, onopen, selectedPath = null,
  }: { files: FileChange[]; truncated?: boolean; onopen: (file: FileChange) => void; selectedPath?: string | null } = $props();

  const LETTER: Record<string, string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C', typechange: 'T', untracked: 'U' };

  function dir(path: string): string {
    const i = path.lastIndexOf('/');
    return i < 0 ? '' : path.slice(0, i + 1);
  }
  function base(path: string): string {
    const i = path.lastIndexOf('/');
    return i < 0 ? path : path.slice(i + 1);
  }
</script>

<div class="files">
  <div class="count muted" data-testid="commit-details-file-count">{files.length === 0 ? t('graph.details.files.none') : tp('graph.details.files', files.length)}</div>
  <ul data-testid="commit-details-file-list" aria-label={t('graph.details.files.other', { n: files.length })}>
    {#each files as f (f.path + '\u0000' + (f.oldPath ?? ''))}
      <li>
        <button
          type="button"
          class="file"
          class:selected={selectedPath === f.path}
          data-testid="commit-details-file-item"
          data-path={f.path}
          data-change={f.change}
          title={t('graph.details.openDiff', { path: f.path })}
          onclick={() => onopen(f)}
        >
          <span class="letter" data-change={f.change} title={t(`graph.change.${f.change}`)}>{LETTER[f.change] ?? '?'}</span>
          <span class="name truncate">
            <span class="dir">{dir(f.path)}</span><span class="base">{base(f.path)}</span>
            {#if f.oldPath}<span class="from muted"> ← {f.oldPath}</span>{/if}
          </span>
          <span class="stat">
            {#if f.binary}
              <span class="muted">{t('graph.details.binary')}</span>
            {:else if f.additions !== null || f.deletions !== null}
              <span class="add">+{f.additions ?? 0}</span> <span class="del">−{f.deletions ?? 0}</span>
            {/if}
          </span>
        </button>
      </li>
    {/each}
  </ul>
  {#if truncated}
    <div class="truncated muted" data-testid="commit-details-truncated">{t('graph.details.truncated')}</div>
  {/if}
</div>

<style>
  .files { display: flex; flex-direction: column; min-height: 0; }
  .count { padding: 6px 12px; font-size: 12px; }
  ul { margin: 0; padding: 0; list-style: none; }
  .file {
    display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; align-items: center; gap: 8px; width: 100%; height: 28px; padding: 0 12px;
    border: 0; background: transparent; color: var(--fg); text-align: left; font-size: 12px;
  }
  .file:hover { background: var(--row-hover); }
  .file.selected { background: var(--row-selected); }
  .file:focus-visible { box-shadow: inset 0 0 0 2px var(--accent); }
  .letter { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 3px; font-size: 10px; font-weight: 700; color: var(--bg); background: var(--fg-muted); }
  .letter[data-change='added'], .letter[data-change='untracked'] { background: var(--success); }
  .letter[data-change='modified'], .letter[data-change='typechange'] { background: var(--warn); }
  .letter[data-change='deleted'] { background: var(--danger); }
  .letter[data-change='renamed'], .letter[data-change='copied'] { background: var(--info); }
  .dir { color: var(--fg-muted); }
  .stat { font-family: var(--font-mono); font-size: 11px; white-space: nowrap; }
  .add { color: var(--success); }
  .del { color: var(--danger); }
  .truncated { padding: 6px 12px 12px; font-size: 12px; }
</style>
