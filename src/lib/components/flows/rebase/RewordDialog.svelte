<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { reportError, op, repo } = captureStores();
  // `reword-dialog`: "Edit message…" of one commit of HEAD's first-parent history. Powered by
  // `rebase_todo_preview { upstream }` (upstream = parent of the commit); summary and description pre-filled from its message.
  // Autonomous dialogue: "Save" closes the dialogue then launches `rebase_interactive_start` [L] (see run-reword.ts).
  // Props: `{ oid }`; `retryAutostash` + `summary` / `body` reopen it after a `DIRTY_WORKTREE`, keeping the typed text.
  import { onMount, tick, untrack } from 'svelte';
  import { t, tp } from '$i18n/index';
  import { trackActivity } from '$lib/activity';
  import DialogShell from '$lib/components/dialogs-base/DialogShell.svelte';
  import Icon from '$lib/components/ui/Icon.svelte';
  import type { DialogProps } from '$lib/dialogs/registry';

  import { commands } from '$lib/ipc/commands';
  import type { TodoPreview } from '$lib/ipc/types';

  import { loadedRowIndex, worktreeDirty } from '../branches/common';
  import { parentOfCommit } from './interactive';
  import { loadErrorText } from './rebase-state';
  import { buildRewordTodo, checkRewordTarget, rewordMessage, splitRewordMessage } from './reword';
  import { startReword } from './run-reword';

  interface Props extends DialogProps<boolean> {
    oid: string;
    /** Re-opened after a `DIRTY_WORKTREE`: relaunches with autostash. */
    retryAutostash?: boolean;
    /** Summary and description typed before the reopening. */
    summary?: string;
    body?: string;
  }

  let { oid, retryAutostash = false, summary: typedSummary, body: typedBody, close }: Props = $props();

  let preview = $state.raw<TodoPreview | null>(null);
  let upstream = $state<string | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let summary = $state(untrack(() => typedSummary ?? ''));
  let body = $state(untrack(() => typedBody ?? ''));
  /** Message of the commit as pre-filled (summary + description): "Save" stays disabled while it is unchanged. */
  let original = $state<string | null>(null);
  /** Between the summary and the description, as in the original message (`splitRewordMessage`). */
  let separator = $state('\n\n');
  let autostash = $state(untrack(() => worktreeDirty()));
  let input = $state<HTMLInputElement | undefined>();

  const dirty = $derived(worktreeDirty());
  const index = $derived(preview ? preview.items.findIndex((i) => i.oid === oid) : -1);
  const target = $derived(preview && index >= 0 ? preview.items[index]! : null);
  /** Commits above the target, rewritten too. */
  const later = $derived(preview && index >= 0 ? preview.items.length - index - 1 : 0);
  const pushedCount = $derived(preview && index >= 0 ? preview.items.slice(index).filter((i) => i.pushed).length : 0);
  const message = $derived(rewordMessage(summary, body, separator));
  const unchanged = $derived(original !== null && message === original);
  const canConfirm = $derived(target !== null && loadError === null && !loading && !op.busy && summary.trim() !== '' && !unchanged);

  /** Base of the rebase: from the loaded lines, otherwise by `commit_details`. `inHead`: already checked on the loaded lines. */
  async function resolveUpstream(): Promise<{ upstream: string | null; inHead: boolean } | null> {
    const check = checkRewordTarget(oid, loadedRowIndex(), repo.head?.oid ?? null);
    if (check.ok) return { upstream: check.upstream, inHead: true };
    if (check.reason !== 'unknown') {
      loadError = t(`reword.disabled.${check.reason}`);
      return null;
    }
    const parent = await parentOfCommit(oid);
    if (parent === undefined) {
      loadError = t('reword.loadFailed'); // details already reported
      return null;
    }
    return { upstream: parent, inHead: false };
  }

  async function load(): Promise<void> {
    const repoId = repo.id;
    if (repoId === null) return;
    loading = true;
    try {
      const range = await resolveUpstream();
      if (!range) return;
      upstream = range.upstream;
      const p = await commands.rebaseTodoPreview({ repoId, upstream: range.upstream });
      const item = p.items.find((i) => i.oid === oid);
      if (!item) {
        // Unchecked target (line not loaded) missing from `upstream..HEAD`: another branch, not a moved HEAD.
        loadError = t(range.inHead ? 'reword.stale' : 'reword.disabled.not-in-head');
        return;
      }
      preview = p;
      const split = splitRewordMessage(item.message);
      separator = split.separator;
      original = rewordMessage(split.summary, split.body, split.separator);
      if (typedSummary === undefined) {
        summary = split.summary;
        body = split.body;
      }
    } catch (e) {
      preview = null;
      reportError(e, {
        command: 'rebase_todo_preview',
        onError: (er) => {
          loadError = loadErrorText(er);
          return true;
        },
      });
    } finally {
      loading = false;
    }
    if (preview) {
      await tick();
      input?.focus();
    }
  }

  onMount(() => {
    void trackActivity('rebase-reword-load', load());
  });

  function confirm(): void {
    const p = preview;
    if (!p || !canConfirm) return;
    const todo = buildRewordTodo(p.items, oid, message);
    if (todo === 'stale') return;
    const useAutostash = retryAutostash || (dirty && autostash);
    close(true);
    void startReword({ oid, upstream, expectedHead: p.head, todo, later, summary, body, autostash: useAutostash });
  }
</script>

<DialogShell
  testid="reword-dialog"
  title={t('reword.title')}
  width={560}
  onclose={() => close()}
  onsubmit={confirm}
>
  {#if loading && !preview && !loadError}
    <p class="muted" data-testid="reword-loading">{t('rebase.todo.loading')}</p>
  {:else if loadError}
    <p class="field-error" role="alert" data-testid="reword-error">{loadError}</p>
  {:else if target}
    {#if retryAutostash}
      <p class="field-error" role="alert" data-testid="reword-dirty">{t('rebase.confirm.dirty.none')}</p>
    {/if}

    <p class="commit" data-testid="reword-commit" data-oid={target.oid} data-pushed={target.pushed ? 'true' : 'false'}>
      <span class="sha mono">{target.shortOid}</span>
      <span class="subject truncate" title={target.summary}>{target.summary}</span>
      {#if target.pushed}<span class="cloud" title={t('rebase.todo.pushed')}><Icon name="cloud" size={13} label={t('rebase.todo.pushed')} /></span>{/if}
    </p>

    <div class="field">
      <label for="reword-summary">{t('reword.summary')}</label>
      <input id="reword-summary" class="input" type="text" autocomplete="off" spellcheck="true" data-testid="reword-summary-input" bind:this={input} bind:value={summary} />
    </div>
    <div class="field">
      <label for="reword-description">{t('reword.description')}</label>
      <textarea id="reword-description" class="textarea message" rows="6" data-testid="reword-description-input" bind:value={body}></textarea>
    </div>

    {#if later > 0}
      <p class="notice" data-testid="reword-rewrite-note">{tp('reword.rewriteNote', later)}</p>
    {/if}
    {#if pushedCount > 0}
      <p class="warning" role="note" data-testid="reword-pushed-warning">
        <Icon name="alert" size={14} />
        <span>{tp('reword.pushedWarning', pushedCount)}</span>
      </p>
    {/if}
    {#if dirty && !retryAutostash}
      <label class="checkbox">
        <input type="checkbox" data-testid="reword-autostash-checkbox" bind:checked={autostash} />
        <span>{t('rebase.todo.autostash')}</span>
      </label>
    {/if}
  {/if}

  {#snippet footer()}
    <button type="button" class="btn" data-testid="reword-cancel-btn" onclick={() => close()}>{t('rebase.confirm.cancel')}</button>
    <button type="button" class="btn btn-primary" data-testid="reword-confirm-btn" disabled={!canConfirm} title={unchanged ? t('reword.unchanged') : undefined} onclick={confirm}>
      {retryAutostash ? t('rebase.confirm.retryAutostash') : t('reword.confirm')}
    </button>
  {/snippet}
</DialogShell>

<style>
  .commit {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 26px;
    margin: 0 0 12px;
    padding: 0 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-elev);
  }
  .sha {
    flex: none;
    color: var(--fg-muted);
  }
  .subject {
    flex: 1;
    min-width: 0;
  }
  .cloud {
    flex: none;
    display: inline-flex;
    color: var(--fg-muted);
  }
  .message {
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .notice {
    margin: 0 0 8px;
    color: var(--fg-muted);
  }
  .warning {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin: 0 0 12px;
    padding: 8px;
    border: 1px solid var(--warn);
    border-radius: var(--radius-sm);
  }
  .warning :global(svg) {
    flex: none;
    margin-top: 2px;
    color: var(--warn);
  }
  .checkbox {
    margin-bottom: 6px;
  }
</style>
