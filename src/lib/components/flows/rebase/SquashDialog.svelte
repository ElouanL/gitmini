<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { reportError, op, repo } = captureStores();
  // `squash-dialog`: "Squash N commits" from the graph selection (consecutive commits only). Powered by
  // `rebase_todo_preview { upstream }` (upstream = parent of the oldest selected commit); pre-filled editable message.
  // Autonomous dialogue: "Squash" closes the dialogue then launches `rebase_interactive_start` [L] (see run-squash.ts).
  // Props: `{ oids }`; `retryAutostash` + `message` reopen it after a `DIRTY_WORKTREE`, keeping the typed message.
  import { onMount, tick, untrack } from 'svelte';
  import { t, tp } from '$i18n/index';
  import { trackActivity } from '$lib/activity';
  import DialogShell from '$lib/components/dialogs-base/DialogShell.svelte';
  import Icon from '$lib/components/ui/Icon.svelte';
  import type { DialogProps } from '$lib/dialogs/registry';

  import { commands } from '$lib/ipc/commands';
  import type { TodoPreview, TodoPreviewItem } from '$lib/ipc/types';

  import { loadedRowIndex, worktreeDirty } from '../branches/common';
  import { parentOfCommit } from './interactive';
  import { loadErrorText } from './rebase-state';
  import { startSquash } from './run-squash';
  import { buildSquashTodo, checkSquashSelection, defaultSquashMessage, orderByParents } from './squash';

  interface Props extends DialogProps<boolean> {
    /** Selected commits, in any order. */
    oids: string[];
    /** Re-opened after a `DIRTY_WORKTREE`: relaunches with autostash. */
    retryAutostash?: boolean;
    /** Message typed before the reopening. */
    message?: string;
  }

  let { oids, retryAutostash = false, message: initialMessage, close }: Props = $props();

  let preview = $state.raw<TodoPreview | null>(null);
  let ordered = $state.raw<string[]>([]);
  let upstream = $state<string | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let message = $state(untrack(() => initialMessage ?? ''));
  let autostash = $state(untrack(() => worktreeDirty()));
  let input = $state<HTMLTextAreaElement | undefined>();

  const dirty = $derived(worktreeDirty());
  const items = $derived.by((): TodoPreviewItem[] => {
    if (!preview) return [];
    const byOid = new Map(preview.items.map((i) => [i.oid, i]));
    return ordered.map((o) => byOid.get(o)).filter((i): i is TodoPreviewItem => i !== undefined);
  });
  const pushedCount = $derived(items.filter((i) => i.pushed).length);
  /** Commits above the range, rewritten too. */
  const rewritten = $derived.by(() => {
    if (!preview || ordered.length === 0) return 0;
    const last = preview.items.findIndex((i) => i.oid === ordered[ordered.length - 1]);
    return last < 0 ? 0 : preview.items.length - last - 1;
  });
  const canConfirm = $derived(preview !== null && loadError === null && !loading && !op.busy && message.trim() !== '');

  /**
   * Oldest first and base of the rebase: from the loaded lines, otherwise parent by parent (`commit_details`).
   * `inHead`: reachability from HEAD already checked (loaded lines only).
   */
  async function resolveRange(): Promise<{ ordered: string[]; upstream: string | null; inHead: boolean } | null> {
    const check = checkSquashSelection(oids, loadedRowIndex(), repo.head?.oid ?? null);
    if (check.ok) return { ordered: check.ordered, upstream: check.upstream, inHead: true };
    if (check.reason !== 'unknown') {
      loadError = t(`rebase.squash.disabled.${check.reason}`);
      return null;
    }
    const parents: Record<string, string | null> = {};
    for (const o of new Set(oids)) {
      const p = await parentOfCommit(o);
      if (p === undefined) {
        loadError = t('rebase.squash.loadFailed'); // details already reported
        return null;
      }
      parents[o] = p;
    }
    const chain = orderByParents(Object.keys(parents), (o) => parents[o] ?? null);
    if (!chain) {
      loadError = t('rebase.squash.disabled.not-consecutive');
      return null;
    }
    return { ordered: chain, upstream: parents[chain[0]!] ?? null, inHead: false };
  }

  async function load(): Promise<void> {
    const repoId = repo.id;
    if (repoId === null) return;
    loading = true;
    try {
      const range = await resolveRange();
      if (!range) return;
      ordered = range.ordered;
      upstream = range.upstream;
      const p = await commands.rebaseTodoPreview({ repoId, upstream: range.upstream });
      if (buildSquashTodo(p.items, range.ordered, '') === 'stale') {
        // Unchecked selection (lines not loaded) missing from `upstream..HEAD`: another branch, not a moved HEAD.
        const outside = !range.inHead && range.ordered.some((o) => !p.items.some((i) => i.oid === o));
        loadError = t(outside ? 'rebase.squash.disabled.not-in-head' : 'rebase.squash.stale');
        return;
      }
      preview = p;
      if (initialMessage === undefined) {
        const byOid = new Map(p.items.map((i) => [i.oid, i]));
        message = defaultSquashMessage(range.ordered.map((o) => byOid.get(o)!));
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
    void trackActivity('rebase-squash-load', load());
  });

  function confirm(): void {
    const p = preview;
    if (!p || !canConfirm) return;
    const todo = buildSquashTodo(p.items, ordered, message);
    if (todo === 'stale') return;
    const useAutostash = retryAutostash || (dirty && autostash);
    close(true);
    void startSquash({ oids: [...oids], upstream, expectedHead: p.head, todo, message, autostash: useAutostash });
  }
</script>

<DialogShell
  testid="squash-dialog"
  title={tp('rebase.squash.title', oids.length)}
  width={560}
  onclose={() => close()}
  onsubmit={confirm}
>
  {#if loading && !preview && !loadError}
    <p class="muted" data-testid="squash-loading">{t('rebase.todo.loading')}</p>
  {:else if loadError}
    <p class="field-error" role="alert" data-testid="squash-error">{loadError}</p>
  {:else if preview}
    {#if retryAutostash}
      <p class="field-error" role="alert" data-testid="squash-dirty">{t('rebase.confirm.dirty.none')}</p>
    {/if}

    <ul class="commits" data-testid="squash-commit-list">
      {#each items as c (c.oid)}
        <li class="commit" data-testid="squash-commit-item" data-oid={c.oid} data-pushed={c.pushed ? 'true' : 'false'}>
          <span class="sha mono">{c.shortOid}</span>
          <span class="subject truncate" title={c.summary}>{c.summary}</span>
          {#if c.pushed}<span class="cloud" title={t('rebase.todo.pushed')}><Icon name="cloud" size={13} label={t('rebase.todo.pushed')} /></span>{/if}
        </li>
      {/each}
    </ul>

    <div class="field">
      <label for="squash-message">{t('rebase.squash.message')}</label>
      <textarea
        id="squash-message"
        class="textarea message"
        rows="6"
        data-testid="squash-message-input"
        bind:this={input}
        bind:value={message}
      ></textarea>
    </div>

    {#if rewritten > 0}
      <p class="notice" data-testid="squash-rewrite-note">{tp('rebase.squash.rewriteNote', rewritten)}</p>
    {/if}
    {#if pushedCount > 0}
      <p class="warning" role="note" data-testid="squash-pushed-warning">
        <Icon name="alert" size={14} />
        <span>{tp('rebase.squash.pushedWarning', pushedCount)}</span>
      </p>
    {/if}
    {#if dirty && !retryAutostash}
      <label class="checkbox">
        <input type="checkbox" data-testid="squash-autostash-checkbox" bind:checked={autostash} />
        <span>{t('rebase.todo.autostash')}</span>
      </label>
    {/if}
  {/if}

  {#snippet footer()}
    <button type="button" class="btn" data-testid="squash-cancel-btn" onclick={() => close()}>{t('rebase.confirm.cancel')}</button>
    <button type="button" class="btn btn-primary" data-testid="squash-confirm-btn" disabled={!canConfirm} onclick={confirm}>
      {retryAutostash ? t('rebase.confirm.retryAutostash') : t('rebase.squash.confirm')}
    </button>
  {/snippet}
</DialogShell>

<style>
  .commits {
    max-height: 180px;
    margin: 0 0 12px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-elev);
  }
  .commit {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 26px;
    padding: 0 8px;
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
