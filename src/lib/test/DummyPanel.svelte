<script lang="ts">
  // Minimum component for lazy loading tests (sign, popover or dialog).
  let { label = 'dummy', close }: { label?: string; close?: (r?: unknown) => void } = $props();
</script>

<div data-testid="dummy-panel">
  <span>{label}</span>
  {#if close}<button type="button" data-testid="dummy-close" onclick={() => close('closed')}>x</button>{/if}
</div>
