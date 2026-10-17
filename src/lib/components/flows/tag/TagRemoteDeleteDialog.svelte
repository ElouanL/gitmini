<script lang="ts">
  // `tag-remote-delete-dialog`: confirmation of the deletion of a tag on a remote (not undoable). Names the tag and the remote,
  // and lets the user choose the remote when there are several. Resolves the remote name (confirm) or `undefined`.
  import { untrack } from 'svelte';
  import { t } from '$i18n/index';
  import DialogShell from '$lib/components/dialogs-base/DialogShell.svelte';
  import type { DialogProps } from '$lib/dialogs/registry';
  import { captureStores } from '$lib/stores/context';

  interface Props extends DialogProps<string> {
    name: string;
    /** Remote selected at opening. */
    remote: string;
  }

  const { refs } = captureStores();
  let { name, remote: initial, close }: Props = $props();

  let remote = $state(untrack(() => initial));
  const suffix = Math.random().toString(36).slice(2, 8);
</script>

<!-- Like every irreversible action: red, initial focus on Cancel, and no submit on Enter. -->
<DialogShell testid="tag-remote-delete-dialog" title={t('tags.remoteDelete.title', { name })} danger width={460} onclose={() => close()}>
  {#if refs.remotes.length > 1}
    <div class="field">
      <label for="tag-remote-delete-remote-{suffix}">{t('tags.remoteDelete.remote')}</label>
      <select id="tag-remote-delete-remote-{suffix}" class="select" data-testid="tag-remote-delete-remote-select" bind:value={remote}>
        {#each refs.remotes as r (r.name)}
          <option value={r.name}>{r.name}</option>
        {/each}
      </select>
    </div>
  {/if}
  <p class="message" data-testid="tag-remote-delete-message">{t('tags.remoteDelete.message', { name, remote })}</p>
  <p class="warning" data-testid="tag-remote-delete-warning">{t('tags.remoteDelete.warning', { remote })}</p>
  {#snippet footer()}
    <button type="button" class="btn" data-testid="tag-remote-delete-cancel-btn" data-autofocus onclick={() => close()}>
      {t('tags.remoteDelete.cancel')}
    </button>
    <button type="button" class="btn btn-danger" data-testid="tag-remote-delete-submit-btn" disabled={remote === ''} onclick={() => close(remote)}>
      {t('tags.remoteDelete.submit', { remote })}
    </button>
  {/snippet}
</DialogShell>

<style>
  .message {
    margin: 8px 0 0;
  }
  .warning {
    margin: 8px 0 0;
    color: var(--fg-muted);
  }
</style>
