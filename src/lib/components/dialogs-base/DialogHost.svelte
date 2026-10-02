<script lang="ts">
  // Hosts the open dialog stack by `openDialog` (src/lib/dialogs/registry.ts).
  import { dialogStack } from '$lib/dialogs/stack.svelte';
  import DialogSlot from './DialogSlot.svelte';
</script>

{#each dialogStack.entries as entry (entry.key)}
  <DialogSlot {entry} />
{/each}
