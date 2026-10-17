<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { refs } = captureStores();
  // `tag-push-dialog`: choice of the remote when there are several. Resolves the remote name (confirm) or `undefined`.
  import { untrack } from 'svelte';
  import { t } from '$i18n/index';
  import DialogShell from '$lib/components/dialogs-base/DialogShell.svelte';
  import type { DialogProps } from '$lib/dialogs/registry';

  interface Props extends DialogProps<string> {
    name: string;
    /** Remote selected at opening. */
    remote: string;
  }

  let { name, remote: initial, close }: Props = $props();

  let remote = $state(untrack(() => initial));
  const suffix = Math.random().toString(36).slice(2, 8);
</script>

<DialogShell testid="tag-push-dialog" title={t('tags.push.title', { name })} width={400} onclose={() => close()} onsubmit={() => close(remote)}>
  <div class="field">
    <label for="tag-push-remote-{suffix}">{t('tags.push.remote')}</label>
    <select id="tag-push-remote-{suffix}" class="select" data-autofocus data-testid="tag-push-remote-select" bind:value={remote}>
      {#each refs.remotes as r (r.name)}
        <option value={r.name}>{r.name}</option>
      {/each}
    </select>
  </div>
  {#snippet footer()}
    <button type="button" class="btn" data-testid="tag-push-cancel-btn" onclick={() => close()}>{t('tags.push.cancel')}</button>
    <button type="button" class="btn btn-primary" data-testid="tag-push-submit-btn" disabled={remote === ''} onclick={() => close(remote)}>
      {t('tags.push.submit')}
    </button>
  {/snippet}
</DialogShell>
