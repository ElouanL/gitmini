<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { reportError, op, refs, repo } = captureStores();
  // `rebase-confirm-dialog` (07 "Single rebase Dialogue") : all simple rebase (slide-and-drop, menus) goes through here, powered
  // by `branch_compare { branch, target }`. Autonomous dialogue: "Rebase" closes the dialogue and then launches `rebase_start` [L]
  // (see run.ts). Props: `{ branch, target }`; `retryAutostash` opens the dialog again after a `DIRTY_WORKTREE`.
  import { onMount } from 'svelte';
  import { t, tp } from '$i18n/index';
  import { trackActivity } from '$lib/activity';
  import DialogShell from '$lib/components/dialogs-base/DialogShell.svelte';
  import Icon from '$lib/components/ui/Icon.svelte';
  import type { DialogProps } from '$lib/dialogs/registry';

  import { shortOid } from '$lib/format';
  import { commands } from '$lib/ipc/commands';
  import type { BranchCompare } from '$lib/ipc/types';

  import { headBranchName } from '../branches/common';
  import { canConfirmRebase, hiddenCommits, isDefaultBranchName, rebaseKind, targetLabel } from './rebase-state';
  import { startRebase } from './run';

  interface Props extends DialogProps<boolean> {
    /** Branch rebased (short name); `null` = current branch. */
    branch?: string | null;
    /** Base of the rebase: ref name (`main`, `origin/dev`) or oid. */
    target: string;
    /** Re-opened after a `DIRTY_WORKTREE`: offers `rebase-retry-autostash-btn`. */
    retryAutostash?: boolean;
    /** Number of files reported by the backend (`retryAutostash` mode message). */
    dirtyCount?: number;
  }

  let { branch = null, target, retryAutostash = false, dirtyCount = 0, close }: Props = $props();

  let compare = $state.raw<BranchCompare | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let autostash = $state(false);
  let autostashTouched = false;
  let defaultChecked = $state(false);

  const current = $derived(headBranchName());
  const branchName = $derived(branch ?? current);
  const displayBranch = $derived(branchName ?? t('rebase.target.head'));
  const shownTarget = $derived(targetLabel(target));
  const kind = $derived(compare ? rebaseKind(compare) : null);
  const defaultBranch = $derived(isDefaultBranchName(branchName));
  const needsCheckout = $derived(branch !== null && branch !== current);
  const hidden = $derived(compare ? hiddenCommits(compare) : 0);
  const remoteName = $derived(
    (branchName ? refs.snapshot?.local.find((b) => b.name === branchName)?.upstream?.ref : null) ?? t('rebase.confirm.remoteGeneric'),
  );
  const canConfirm = $derived(
    canConfirmRebase(compare, { busy: op.busy, defaultBranch: defaultBranch && !retryAutostash, defaultChecked }),
  );

  async function load(): Promise<void> {
    const repoId = repo.id;
    if (repoId === null) return;
    loading = true;
    try {
      const c = await commands.branchCompare({ repoId, branch, target });
      compare = c;
      if (!autostashTouched) autostash = c.dirty;
    } catch (e) {
      compare = null;
      reportError(e, {
        command: 'branch_compare',
        onError: (er) => {
          if (er.code === 'NOT_FOUND') {
            loadError = t('rebase.confirm.gone', { target: shownTarget });
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
    void trackActivity('rebase-compare', load());
  });

  function confirm(withAutostash: boolean): void {
    if (!compare || !canConfirm) return;
    const run = { branch, target, autostash: withAutostash, replayed: compare.ahead, kind: rebaseKind(compare) };
    close(true);
    void startRebase(run);
  }

  const sha = (oid: string) => shortOid(oid);
</script>

<DialogShell
  testid="rebase-confirm-dialog"
  title={t('rebase.confirm.title')}
  width={520}
  onclose={() => close()}
  onsubmit={() => confirm(retryAutostash ? true : autostash)}
  attrs={{ 'data-kind': kind ?? undefined }}
>
  {#if loading && !compare}
    <p class="muted" data-testid="rebase-confirm-loading">{t('rebase.confirm.loading')}</p>
  {:else if loadError}
    <p class="field-error" role="alert" data-testid="rebase-confirm-error">{loadError}</p>
  {:else if compare && kind}
    {#if retryAutostash}
      <p class="field-error" role="alert" data-testid="rebase-confirm-dirty">
        {dirtyCount > 0 ? tp('rebase.confirm.dirty', dirtyCount) : t('rebase.confirm.dirty.none')}
      </p>
    {/if}

    <p class="summary" data-testid="rebase-confirm-summary">
      {#if kind === 'nothing'}
        {t('rebase.confirm.nothing', { branch: displayBranch, target: shownTarget })}
      {:else if kind === 'advance'}
        {t('rebase.confirm.advance', { branch: displayBranch, target: shownTarget })}
      {:else}
        {tp('rebase.confirm.replay', compare.ahead, { branch: displayBranch, target: shownTarget, sha: sha(compare.targetOid) })}
      {/if}
    </p>

    {#if kind === 'replay' && compare.commits.length > 0}
      <ul class="commits" data-testid="rebase-commit-list">
        {#each compare.commits as c (c.oid)}
          <li class="commit" data-testid="rebase-commit-item" data-oid={c.oid} data-pushed={c.pushed ? 'true' : 'false'}>
            <span class="sha mono">{sha(c.oid)}</span>
            <span class="subject truncate" title={c.summary}>{c.summary}</span>
            {#if c.pushed}<span class="cloud" title={t('rebase.confirm.pushedCommit')}><Icon name="cloud" size={13} label={t('rebase.confirm.pushedCommit')} /></span>{/if}
          </li>
        {/each}
        {#if hidden > 0}
          <li class="more muted">{tp('rebase.confirm.more', hidden)}</li>
        {/if}
      </ul>
    {/if}

    {#if needsCheckout && kind !== 'nothing'}
      <p class="notice" data-testid="rebase-checkout-notice">{t('rebase.confirm.checkoutNotice', { branch: displayBranch })}</p>
    {/if}
    {#if compare.merges > 0 && kind === 'replay'}
      <p class="notice" data-testid="rebase-merges-notice">{tp('rebase.confirm.mergesNotice', compare.merges)}</p>
    {/if}
    {#if compare.pushed > 0 && kind !== 'nothing'}
      <p class="warning" role="note" data-testid="rebase-pushed-warning">
        <Icon name="alert" size={14} />
        <span>{tp('rebase.confirm.pushedWarning', compare.pushed, { remote: remoteName })}</span>
      </p>
    {/if}

    {#if defaultBranch && !retryAutostash && kind !== 'nothing'}
      <label class="checkbox">
        <input type="checkbox" data-testid="rebase-confirm-default-branch-checkbox" bind:checked={defaultChecked} />
        <span>{t('rebase.confirm.defaultBranch', { branch: displayBranch })}</span>
      </label>
    {/if}
    {#if compare.dirty && kind !== 'nothing' && !retryAutostash}
      <label class="checkbox">
        <input
          type="checkbox"
          data-testid="rebase-autostash-checkbox"
          bind:checked={autostash}
          onchange={() => (autostashTouched = true)}
        />
        <span>{t('rebase.confirm.autostash')}</span>
      </label>
    {/if}
  {/if}

  {#snippet footer()}
    <button type="button" class="btn" data-testid="rebase-cancel-btn" onclick={() => close()}>
      {kind === 'nothing' ? t('rebase.confirm.close') : t('rebase.confirm.cancel')}
    </button>
    {#if retryAutostash}
      <button
        type="button"
        class="btn btn-primary"
        data-autofocus
        data-testid="rebase-retry-autostash-btn"
        disabled={!canConfirm}
        onclick={() => confirm(true)}
      >
        {t('rebase.confirm.retryAutostash')}
      </button>
    {:else if kind !== 'nothing'}
      <button type="button" class="btn btn-primary" data-testid="rebase-confirm-btn" disabled={!canConfirm} onclick={() => confirm(autostash)}>
        {t('rebase.confirm.confirm')}
      </button>
    {/if}
  {/snippet}
</DialogShell>

<style>
  .summary {
    margin: 8px 0;
    font-weight: 600;
  }
  .commits {
    max-height: 220px;
    margin: 0 0 12px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-elev);
  }
  .commit,
  .more {
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
