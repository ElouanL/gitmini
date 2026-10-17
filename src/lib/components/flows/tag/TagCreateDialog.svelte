<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { op, refs, repo } = captureStores();
  // `tag-create-dialog`: name validated live (same rules as a branch, plus the tags already there), the tagged commit, and an
  // optional message that makes the tag annotated. A name the backend refuses shows under the field.
  import { untrack } from 'svelte';
  import { t } from '$i18n/index';
  import DialogShell from '$lib/components/dialogs-base/DialogShell.svelte';
  import type { DialogProps } from '$lib/dialogs/registry';
  import { createTag, tagTargetLabel } from './run';
  import { conflictMessage, normalizeTagInput, tagConflict, tagProblemMessage, validateTagName } from './tag-logic';

  interface Props extends DialogProps<boolean> {
    /** Full oid of the commit to tag; `null` = HEAD (the backend resolves it). */
    target?: string | null;
  }

  let { target = null, close }: Props = $props();

  const targetLabel = untrack(() => tagTargetLabel(target));

  let name = $state('');
  let message = $state('');
  let serverError = $state<string | null>(null);
  let busy = $state(false);

  const problem = $derived(validateTagName(name));
  const conflict = $derived(problem === null ? tagConflict(name, refs.snapshot?.tags ?? []) : null);
  const error = $derived(serverError ?? (problem ? tagProblemMessage(problem) : conflict ? conflictMessage(name, conflict) : null));
  const annotated = $derived(message.trim() !== '');
  const canSubmit = $derived(name !== '' && problem === null && conflict === null && !busy && !op.busy && !repo.head?.unborn);
  const suffix = Math.random().toString(36).slice(2, 8);

  function onInput(e: Event & { currentTarget: HTMLInputElement }): void {
    const el = e.currentTarget;
    const normalized = normalizeTagInput(el.value);
    if (normalized !== el.value) el.value = normalized;
    name = normalized;
    serverError = null;
  }

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    busy = true;
    serverError = null;
    const outcome = await createTag({ name, target, message });
    busy = false;
    if (outcome.ok) close(true);
    else serverError = outcome.fieldError;
  }
</script>

<DialogShell testid="tag-create-dialog" title={t('tags.create.title')} attrs={{ 'data-annotated': String(annotated) }} onclose={() => close()} onsubmit={() => void submit()}>
  <div class="field">
    <label for="tag-name-{suffix}">{t('tags.create.name')}</label>
    <input
      id="tag-name-{suffix}"
      class="input"
      type="text"
      autocomplete="off"
      spellcheck="false"
      data-autofocus
      data-testid="tag-create-name-input"
      placeholder={t('tags.create.namePlaceholder')}
      value={name}
      aria-invalid={error ? 'true' : undefined}
      aria-describedby={error ? `tag-error-${suffix}` : undefined}
      oninput={onInput}
    />
    {#if error}
      <div class="field-error" id="tag-error-{suffix}" role="alert" data-testid="tag-create-error">{error}</div>
    {/if}
  </div>
  <div class="field">
    <span class="field-label">{t('tags.create.target')}</span>
    <div class="target truncate" data-testid="tag-create-target" title={targetLabel}>{targetLabel}</div>
  </div>
  <div class="field">
    <label for="tag-message-{suffix}">{t('tags.create.message')}</label>
    <textarea
      id="tag-message-{suffix}"
      class="input"
      rows="3"
      data-testid="tag-create-message-input"
      aria-describedby="tag-hint-{suffix}"
      bind:value={message}
    ></textarea>
    <div class="hint" id="tag-hint-{suffix}">{t('tags.create.messageHint')}</div>
  </div>

  {#snippet footer()}
    <button type="button" class="btn" data-testid="tag-create-cancel-btn" onclick={() => close()}>{t('tags.create.cancel')}</button>
    <button type="button" class="btn btn-primary" data-testid="tag-create-submit-btn" disabled={!canSubmit} onclick={() => void submit()}>
      {t('tags.create.submit')}
    </button>
  {/snippet}
</DialogShell>

<style>
  .target {
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-elev);
    font-family: var(--font-mono);
    font-size: 12px;
  }
  textarea {
    resize: vertical;
    min-height: 56px;
  }
  .hint {
    margin-top: 4px;
    color: var(--fg-muted);
    font-size: 12px;
  }
</style>
