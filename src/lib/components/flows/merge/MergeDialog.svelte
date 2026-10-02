<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { reportError, op, refs, repo, runWrite } = captureStores();
  // `merge-dialog` (06 "Merge") : standalone dialog. Opened by the `merge` menu entries and by the repository of a branch on the
  // current branch (`openDialog('merge-dialog', { ref })`). Pre-analysis by `branch_compare { branch: null, target: ref }`,
  // Then `merge_branch { ref, mode, message? }`. A conflict closes the dialogue: the banner of the base takes over.
  import { onMount } from 'svelte';
  import { t, tp } from '$i18n/index';
  import { trackActivity } from '$lib/activity';
  import { runAction } from '$lib/actions/registry';
  import DialogShell from '$lib/components/dialogs-base/DialogShell.svelte';
  import { offerUndo } from '$lib/components/flows/undo/offer-undo';
  import type { DialogProps } from '$lib/dialogs/registry';
  import { commands, type MergeMode } from '$lib/ipc/commands';
  import type { BranchCompare } from '$lib/ipc/types';

  import { toast } from '$lib/stores/toast.svelte';
  import { headBranchName } from '../branches/common';
  import { canSubmitMerge, effectiveMode, ffOnlyDisabled, mergeKind, willCreateMergeCommit } from './merge-state';

  interface Props extends DialogProps<boolean> {
    /** Branch to merge in the current branch (short name: `feature`, `origin/dev`). */
    ref: string;
  }

  let { ref, close }: Props = $props();

  let compare = $state.raw<BranchCompare | null>(null);
  let loading = $state(true);
  let chosen = $state<MergeMode>('ff');
  let message = $state('');
  let messageEdited = $state(false);
  let serverError = $state<string | null>(null);
  /** `DIRTY_WORKTREE` received from backend after pre-analysis (race): same effect as `compare.dirty`. */
  let serverDirty = $state(false);
  let busy = $state(false);

  const head = $derived(headBranchName() ?? 'HEAD');
  const kind = $derived(compare ? mergeKind(compare) : null);
  const mode = $derived(kind ? effectiveMode(kind, chosen) : chosen);
  const showMessage = $derived(kind ? willCreateMergeCommit(kind, mode) : false);
  const dirty = $derived((compare?.dirty ?? false) || serverDirty);
  const error = $derived(serverError ?? (dirty ? t('merge.error.dirty') : null));
  const canSubmit = $derived(canSubmitMerge(compare, { busy: busy || op.busy, serverDirty }));

  const hint = $derived.by(() => {
    if (!compare || !kind) return '';
    if (kind === 'up-to-date') return t('merge.hint.upToDate');
    if (kind === 'fast-forward') return tp('merge.hint.ff', compare.behind);
    return t('merge.hint.diverged');
  });

  const summary = $derived(
    compare && kind !== 'up-to-date' ? tp('merge.summary', compare.behind, { ref, head }) : t('merge.summary.upToDate', { ref, head }),
  );

  // A chosen ff-only that becomes impossible falls back on ff (06).
  $effect(() => {
    if (kind && ffOnlyDisabled(kind) && chosen === 'ff-only') chosen = 'ff';
  });

  async function load(): Promise<void> {
    const repoId = repo.id;
    if (repoId === null) return;
    loading = true;
    try {
      const c = await commands.branchCompare({ repoId, branch: null, target: ref });
      compare = c;
      if (!messageEdited) message = c.defaultMergeMessage;
    } catch (e) {
      compare = null;
      reportError(e, {
        command: 'branch_compare',
        onError: (er) => {
          if (er.code === 'NOT_FOUND') {
            serverError = t('merge.error.gone', { ref });
            void refs.reloadRefs();
            return true;
          }
          return false;
        },
      });
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void trackActivity('merge-compare', load());
  });

  async function stash(): Promise<void> {
    if (busy) return;
    busy = true;
    // Same path as the toolbar button (08): stash immediately; then the pre-analysis is recalculated.
    await runAction('stash.save');
    serverDirty = false;
    serverError = null;
    busy = false;
    await load();
  }

  async function submit(): Promise<void> {
    const repoId = repo.id;
    if (!canSubmit || repoId === null || !compare) return;
    busy = true;
    serverError = null;
    const sendMessage = showMessage && message.trim() !== '';
    const res = await runWrite(
      t('merge.op'),
      () => commands.mergeBranch({ repoId, ref, mode, ...(sendMessage ? { message } : {}) }),
      {
        command: 'merge_branch',
        data: { ref },
        onError: (e) => {
          if (e.code === 'REJECTED_NON_FF' && e.details?.operation === 'merge') {
            serverError = t('merge.error.diverged');
            void load();
            return true;
          }
          if (e.code === 'DIRTY_WORKTREE') {
            serverDirty = true;
            return true;
          }
          if (e.code === 'NOT_FOUND') {
            serverError = t('merge.error.gone', { ref });
            void refs.reloadRefs();
            return true;
          }
          // Conflict (or `pre-merge-commit` hook that refuses): the merge remains in progress, the banner of the base takes over.
          if (e.code === 'CONFLICT') close(false);
          return false;
        },
      },
    );
    busy = false;
    if (!res.ok) return;
    close(true);
    const outcome = res.value.result;
    if (outcome === 'up-to-date') {
      toast.info(t('toast.alreadyUpToDate'));
      return;
    }
    const label = t(outcome === 'fast-forward' ? 'merge.done.ff' : 'merge.done.merged', { ref, head });
    void trackActivity('merge-undo-toast', offerUndo(label, 'merge'));
  }
</script>

<DialogShell testid="merge-dialog" title={t('merge.title')} onclose={() => close()} onsubmit={() => void submit()}>
  {#if loading && !compare}
    <p class="muted" data-testid="merge-loading">{t('merge.loading')}</p>
  {:else}
    <p class="summary" data-testid="merge-summary">{summary}</p>
    <p class="hint" data-testid="merge-ff-hint" data-kind={kind ?? undefined}>{hint}</p>

    <fieldset class="modes" disabled={!compare}>
      <legend class="sr-only">{t('merge.mode.label')}</legend>
      <label class="radio">
        <input type="radio" name="merge-mode" value="ff" data-testid="merge-mode-ff" bind:group={chosen} />
        <span>{t('merge.mode.ff')}</span>
      </label>
      <label class="radio">
        <input type="radio" name="merge-mode" value="no-ff" data-testid="merge-mode-no-ff" bind:group={chosen} />
        <span>{t('merge.mode.no-ff')}</span>
      </label>
      <label class="radio" class:off={kind !== null && ffOnlyDisabled(kind)}>
        <input
          type="radio"
          name="merge-mode"
          value="ff-only"
          data-testid="merge-mode-ff-only"
          bind:group={chosen}
          disabled={kind !== null && ffOnlyDisabled(kind)}
        />
        <span>
          {t('merge.mode.ff-only')}
          {#if kind !== null && ffOnlyDisabled(kind)}<span class="muted">({t('merge.mode.ff-only.disabled')})</span>{/if}
        </span>
      </label>
    </fieldset>

    {#if showMessage}
      <div class="field">
        <label for="merge-message">{t('merge.message.label')}</label>
        <textarea
          id="merge-message"
          class="textarea"
          rows="2"
          data-testid="merge-message-input"
          bind:value={message}
          oninput={() => (messageEdited = true)}
        ></textarea>
      </div>
    {/if}

    {#if error}
      <div class="field-error error" role="alert" data-testid="merge-error">{error}</div>
    {/if}
    {#if dirty}
      <div class="stash-row">
        <button type="button" class="btn" data-testid="merge-stash-btn" disabled={busy || op.busy} onclick={() => void stash()}>
          {t('merge.stash')}
        </button>
      </div>
    {/if}
  {/if}

  {#snippet footer()}
    <button type="button" class="btn" data-testid="merge-cancel-btn" onclick={() => close()}>{t('merge.cancel')}</button>
    <button type="button" class="btn btn-primary" data-testid="merge-submit-btn" disabled={!canSubmit} onclick={() => void submit()}>
      {t('merge.submit')}
    </button>
  {/snippet}
</DialogShell>

<style>
  .summary {
    margin: 8px 0 4px;
    font-weight: 600;
  }
  .hint {
    margin: 0 0 12px;
    color: var(--fg-muted);
  }
  .modes {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0 0 12px;
    padding: 0;
    border: 0;
  }
  .radio {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .radio.off {
    color: var(--fg-muted);
  }
  .error {
    margin-bottom: 8px;
  }
  .stash-row {
    display: flex;
    justify-content: flex-start;
  }
</style>
