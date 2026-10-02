<script lang="ts">
  // `mainline-dialog` (09 "Main Parent Dialogue"): open only if the selection contains at least one merge commit.
  // Resolve `{ mainline, recordOrigin }` (confirm) or `undefined` (cancel). Wordings taken from lines already loaded with the graph,
  // without calling IPC.
  import { t } from '$i18n/index';
  import DialogShell from '$lib/components/dialogs-base/DialogShell.svelte';
  import type { DialogProps } from '$lib/dialogs/registry';
  import { shortOid } from '$lib/format';
  import { loadedRowIndex } from '../branches/common';
  import { mainlineChoices, parentLabel, type MergeInfo, type PickKind } from './mainline';
  import type { MainlineResult } from './run';

  interface Props extends DialogProps<MainlineResult> {
    action: PickKind;
    merges: MergeInfo[];
    /** The selection mix merges and commits simple: only parent 1 is possible. */
    mixed?: boolean;
  }

  let { action, merges, mixed = false, close }: Props = $props();

  const simple = $derived(mixed ? 1 : 0);
  const choices = $derived(mainlineChoices(merges, simple));
  const rows = loadedRowIndex();
  const options = $derived(
    Array.from({ length: choices.max }, (_, i) => {
      const n = i + 1;
      // A single merge: full wording of the parent; several merges: "Parent n".
      const label = merges.length === 1 ? parentLabel(n, merges[0]!.parents[i], rows) : t('pick.mainline.option.generic', { n });
      return { value: String(n), label };
    }),
  );

  let value = $state('1');
  let recordOrigin = $state(false);

  function confirm(): void {
    close({ mainline: Number(value), recordOrigin: action === 'cherry-pick' && recordOrigin });
  }
</script>

<DialogShell
  testid="mainline-dialog"
  title={t(`pick.mainline.title.${action}`)}
  width={520}
  attrs={{ 'data-action': action }}
  onclose={() => close()}
  onsubmit={confirm}
>
  <p class="label">{t('pick.mainline.merges')}</p>
  <ul class="merges" data-testid="mainline-merge-list">
    {#each merges as m (m.oid)}
      <li class="merge" data-testid="mainline-merge-item" data-oid={m.oid}>
        <span class="sha mono">{shortOid(m.oid)}</span>
        <span class="truncate" title={m.summary ?? ''}>{m.summary ?? ''}</span>
      </li>
    {/each}
  </ul>

  <div class="field">
    <label for="mainline-select">{t('pick.mainline.parent')}</label>
    <select id="mainline-select" class="select" data-autofocus data-testid="mainline-select" bind:value>
      {#each options as o (o.value)}
        <option value={o.value}>{o.label}</option>
      {/each}
    </select>
    {#if choices.forced}
      <p class="muted hint" data-testid="mainline-forced-hint">{t('pick.mainline.forced')}</p>
    {/if}
  </div>

  {#if action === 'cherry-pick'}
    <label class="checkbox">
      <input type="checkbox" data-testid="mainline-record-origin-checkbox" bind:checked={recordOrigin} />
      <span>{t('pick.mainline.recordOrigin')}</span>
    </label>
  {:else}
    <p class="warning" role="note" data-testid="mainline-revert-warning">{t('pick.mainline.revertWarning')}</p>
  {/if}

  {#snippet footer()}
    <button type="button" class="btn" data-testid="mainline-cancel-btn" onclick={() => close()}>{t('pick.mainline.cancel')}</button>
    <button type="button" class="btn btn-primary" data-testid="mainline-confirm-btn" onclick={confirm}>
      {t(`pick.mainline.confirm.${action}`)}
    </button>
  {/snippet}
</DialogShell>

<style>
  .label {
    margin: 8px 0 4px;
    font-weight: 600;
    font-size: 12px;
    color: var(--fg-muted);
  }
  .merges {
    margin: 0 0 12px;
    max-height: 120px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-elev);
  }
  .merge {
    display: flex;
    gap: 8px;
    height: 26px;
    align-items: center;
    padding: 0 8px;
  }
  .sha {
    flex: none;
    color: var(--fg-muted);
  }
  .hint {
    margin: 4px 0 0;
    font-size: 12px;
  }
  .warning {
    margin: 0;
    padding: 8px;
    border: 1px solid var(--warn);
    border-radius: var(--radius-sm);
  }
</style>
