// Reactive wired form from commit out of component: the draft of a finished (or abandoned) merge is forgotten even if
// `wt-panel` is not displayed at that time (end of the merge by `op-banner-continue-btn`).
import { opFor } from '$lib/stores/op.svelte';
import { repo } from '$lib/stores/repo.svelte';
import { activeSession } from '$lib/stores/session.svelte';
import { commitFormFor } from './form-state.svelte';

let stop: (() => void) | null = null;

export function startCommitFormWiring(): void {
  stop?.();
  stop = $effect.root(() => {
    $effect(() => {
      const owners = repo.tabs.includes(activeSession.current) ? repo.tabs : [...repo.tabs, activeSession.current];
      for (const owner of owners) if (opFor(owner).state?.kind !== 'merge') commitFormFor(owner).resetMerge();
    });
  });
}

export function stopCommitFormWiring(): void {
  stop?.();
  stop = null;
}
