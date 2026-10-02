<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { op, repo, status, commitForm } = captureStores();
  // commit Form (05 "commit Form"): summary, description, actual author, amend, button, hook output.
  // Masked during rebase, cherry-pick, revert and am (continuation passes through `op-banner`); in merge, "Finish the merge".
  import { runAction } from '$lib/actions/registry';
  import { formatKeys } from '$lib/actions/shortcuts';
  import { openDialog } from '$lib/dialogs/registry';

  import { t, tp } from '$i18n/index';
  import { canSubmit, counterLevel, disabledReason, formMode, formVisible, headIsPushed, stagedCount, summaryLength } from './commit-logic';

  const opState = $derived(op.state);
  const visible = $derived(formVisible(opState));
  const mode = $derived(formMode(opState, commitForm.amend));
  const merging = $derived(mode === 'merge');

  // Draft by repository (path to repository): retained as long as the app is open.
  $effect(() => {
    commitForm.activate(repo.info?.workdir ?? '');
  });
  // Merge in progress: pre-filled summary with `Merge branch '<incoming>'`, editable.
  $effect(() => {
    if (opState?.kind === 'merge') commitForm.prefillMerge(opState.incoming);
  });

  const summary = $derived(merging ? commitForm.mergeSummary : commitForm.summary);
  const body = $derived(merging ? commitForm.mergeBody : commitForm.body);
  const count = $derived(summaryLength(summary));
  const level = $derived(counterLevel(count));

  const files = $derived(status.files);
  const staged = $derived(stagedCount(files));
  const conflicts = $derived(opState?.conflictedPaths.length ?? 0);
  const inputs = $derived({ mode, summary, stagedCount: staged, conflictCount: conflicts, busy: op.busy });
  const enabled = $derived(canSubmit(inputs));
  const reason = $derived(disabledReason(inputs));

  const head = $derived(repo.head);
  const amendDisabled = $derived(merging || !head || head.unborn || !head.oid);
  const pushed = $derived(commitForm.amend && !merging && headIsPushed(status.snapshot));
  const upstream = $derived(status.snapshot?.upstream ?? '');

  const identity = $derived(repo.info?.identity ?? null);
  const label = $derived(mode === 'merge' ? t('commit.submit.merge') : mode === 'amend' ? t('commit.submit.amend') : tp('commit.submit.commit', staged));

  function setSummary(v: string): void {
    if (merging) commitForm.mergeSummary = v;
    else commitForm.summary = v;
  }
  function setBody(v: string): void {
    if (merging) commitForm.mergeBody = v;
    else commitForm.body = v;
  }

  async function submit(): Promise<void> {
    if (!enabled) return;
    if (merging) {
      // `op.continue`: same path as `op-banner-continue-btn` (merge_continue, form message via the message provider).
      commitForm.clearHook();
      await runAction('op.continue');
    } else {
      await commitForm.submit();
    }
  }

  function onkeydown(e: KeyboardEvent): void {
    // Mod+Enter: commit (03 "Keyboard"). The key is consumed so that the global dispatcher ignores it.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && !e.isComposing) {
      e.preventDefault();
      void submit();
    }
  }

  function editIdentity(): void {
    void openDialog<boolean>('identity-dialog', { prefill: identity });
  }

  const submitHint = $derived(formatKeys('Mod+Enter'));
  const disabledText = $derived(
    reason === 'busy' ? t('commit.disabled.busy')
      : reason === 'summary' ? t('commit.disabled.summary')
        : reason === 'nothing-staged' ? t('commit.disabled.nothingStaged')
          : reason === 'conflicts' ? t('commit.disabled.conflicts') : '',
  );
</script>

{#if visible}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="form" data-testid="commit-form" data-mode={mode} {onkeydown}>
    <div class="summary-row">
      <input
        class="input"
        type="text"
        data-testid="commit-summary-input"
        data-zone-focus
        placeholder={t('commit.summary.placeholder')}
        aria-label={t('commit.summary.label')}
        autocomplete="off"
        spellcheck="false"
        value={summary}
        oninput={(e) => setSummary(e.currentTarget.value)}
        onchange={(e) => setSummary(e.currentTarget.value)}
      />
      <span class="counter" data-testid="commit-summary-count" data-level={level} title="{count} / 72">{count}</span>
    </div>
    <textarea
      class="textarea"
      rows="3"
      data-testid="commit-body-input"
      placeholder={t('commit.body.placeholder')}
      aria-label={t('commit.body.label')}
      value={body}
      oninput={(e) => setBody(e.currentTarget.value)}
      onchange={(e) => setBody(e.currentTarget.value)}
    ></textarea>

    <button type="button" class="author" data-testid="commit-author" data-configured={identity ? 'true' : 'false'} title={t('commit.author.edit')} onclick={editIdentity}>
      {#if identity}
        {t('commit.author', { name: identity.name, email: identity.email, scope: t(`commit.scope.${identity.scope}`) })}
      {:else}
        {t('commit.author.none')}
      {/if}
    </button>

    {#if !merging}
      <label class="amend checkbox">
        <input
          type="checkbox"
          data-testid="commit-amend-toggle"
          checked={commitForm.amend}
          disabled={amendDisabled || op.busy}
          onchange={(e) => void commitForm.setAmend(e.currentTarget.checked)}
        />
        <span>{t('commit.amend')}</span>
      </label>
    {/if}
    {#if pushed}
      <p class="warning" role="alert" data-testid="commit-amend-pushed-warning">{t('commit.amend.pushed', { upstream })}</p>
    {/if}

    {#if commitForm.hook}
      <details class="hook" open data-testid="commit-hook-output" data-command={commitForm.hook.command}>
        <summary>{t('commit.hook.title')}</summary>
        <pre>{commitForm.hook.stderr || t('commit.hook.empty')}</pre>
      </details>
    {/if}

    <button
      type="button"
      class="btn btn-primary submit"
      data-testid="commit-submit-btn"
      disabled={!enabled}
      title={enabled ? submitHint : disabledText}
      onclick={() => void submit()}
    >
      {label}
    </button>
  </div>
{/if}

<style>
  .form {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px 10px;
    border-top: 1px solid var(--border);
    background: var(--bg-elev);
  }
  .summary-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .counter {
    flex: none;
    min-width: 24px;
    text-align: right;
    font: 12px var(--font-mono);
    color: var(--fg-muted);
  }
  .counter[data-level='warn'] {
    color: var(--warn);
  }
  .counter[data-level='danger'] {
    color: var(--danger);
    font-weight: 600;
  }
  .author {
    align-self: flex-start;
    max-width: 100%;
    padding: 0;
    border: 0;
    background: none;
    color: var(--fg-muted);
    font-size: 12px;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .author:hover {
    color: var(--fg);
    text-decoration: underline;
  }
  .author[data-configured='false'] {
    color: var(--warn);
  }
  .amend {
    font-size: 12px;
  }
  .warning {
    margin: 0;
    padding: 6px 8px;
    border: 1px solid var(--warn);
    border-radius: var(--radius-sm);
    font-size: 12px;
    color: var(--warn);
  }
  .hook {
    border: 1px solid var(--danger);
    border-radius: var(--radius-sm);
    background: var(--bg);
    font-size: 12px;
  }
  .hook summary {
    padding: 4px 8px;
    color: var(--danger);
    cursor: pointer;
  }
  .hook pre {
    margin: 0;
    padding: 6px 8px;
    max-height: 140px;
    overflow: auto;
    font: 12px/1.4 var(--font-mono);
    white-space: pre-wrap;
    word-break: break-word;
    border-top: 1px solid var(--border);
  }
  .submit {
    width: 100%;
  }
</style>
