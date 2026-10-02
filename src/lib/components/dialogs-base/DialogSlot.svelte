<script lang="ts">
  import { setContext } from 'svelte';
  import type { DialogEntry } from '$lib/dialogs/stack.svelte';
  import { dialogStack } from '$lib/dialogs/stack.svelte';

  let { entry }: { entry: DialogEntry } = $props();

  // Provides its key to children's components (DialogShell knows if it is the dialogue above).
  setContext('gitmini-dialog', {
    get key() {
      return entry.key;
    },
  });

  const Dialog = $derived(entry.component);
  const close = (result?: unknown) => dialogStack.close(entry.key, result);
</script>

<Dialog {...entry.props} {close} />
