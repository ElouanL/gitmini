<script lang="ts">
  // Result of the merge dry run, as a short note: the verdict and, unless `compact`, the files that would conflict.
  // Used by the merge dialog (`merge-preview`) and by the menu shown after dropping a branch (`graph-drop-menu-preview`).
  import { t, tp } from '$i18n/index';
  import type { PreviewState } from './loader.svelte';
  import { conflictKindLabel, hiddenConflicts, previewSummary, previewTone } from './preview';

  interface Props {
    value: PreviewState;
    /** Prefix of the test ids (`<testid>`, `<testid>-summary`, `<testid>-file`). */
    testid: string;
    /** Lets a control point at the note with `aria-describedby`. */
    id?: string;
    /** One line, no file list. */
    compact?: boolean;
  }

  let { value, testid, id, compact = false }: Props = $props();
</script>

{#if value.status !== 'idle'}
  <div
    {id}
    class="note"
    class:compact
    role="status"
    data-testid={testid}
    data-state={value.status}
    data-kind={value.status === 'ready' ? value.preview.kind : undefined}
    data-tone={value.status === 'ready' ? previewTone(value.preview) : 'info'}
  >
    {#if value.status === 'loading'}
      <p class="line">{t('merge.preview.loading')}</p>
    {:else if value.status === 'failed'}
      <p class="line">{t('merge.preview.failed')}</p>
    {:else}
      {@const p = value.preview}
      <p class="line" data-testid="{testid}-summary">{previewSummary(p)}</p>
      {#if !compact && p.kind === 'conflicts'}
        {#if p.conflicts.length > 0}
          <!-- Scrollable, so it has to be reachable with the keyboard. -->
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <ul class="files" tabindex="0" aria-label={t('merge.preview.files')}>
            {#each p.conflicts as c (c.path)}
              <li data-testid="{testid}-file" data-path={c.path} data-kind={c.kind}>
                <code>{c.path}</code>
                <span class="kind">{conflictKindLabel(c.kind)}</span>
              </li>
            {/each}
          </ul>
        {/if}
        {#if hiddenConflicts(p) > 0}
          <p class="more" data-testid="{testid}-more">{tp('merge.preview.more', hiddenConflicts(p))}</p>
        {/if}
        <p class="hint">{t('merge.preview.conflicts.hint')}</p>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .note {
    margin: 0 0 12px;
    font-size: 12px;
  }
  .note.compact {
    margin: 0;
    padding: 2px 10px 6px;
  }
  p {
    margin: 0;
  }
  .line {
    font-weight: 600;
    color: var(--fg-muted);
  }
  .note[data-tone='ok'] .line {
    color: var(--success);
  }
  .note[data-tone='warn'] .line {
    color: var(--warn);
  }
  .note[data-tone='error'] .line {
    color: var(--danger);
  }
  .note[data-state='loading'] .line,
  .note[data-state='failed'] .line {
    font-weight: 400;
  }
  .files {
    margin: 6px 0 0;
    padding: 4px 8px;
    max-height: 132px;
    overflow: auto;
    list-style: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-sunken);
  }
  .files li {
    display: flex;
    gap: 8px;
    justify-content: space-between;
    padding: 2px 0;
  }
  code {
    font-family: var(--font-mono);
    overflow-wrap: anywhere;
  }
  .kind {
    flex: none;
    color: var(--fg-muted);
  }
  .more,
  .hint {
    margin-top: 4px;
    color: var(--fg-muted);
  }
</style>
