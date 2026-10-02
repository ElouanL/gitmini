import { activeSession, type Session } from '$lib/stores/session.svelte';
// Reactive guard of 11 that do not have a clean component:
// - Git LFS (§5) : `RepoInfo.lfs` → a `toast[data-kind=info]` one times when opening the restoration (never restated with refreshment).
import { untrack } from 'svelte';
import { t } from '$i18n/index';
import { repo } from '$lib/stores/repo.svelte';
import { toast } from '$lib/stores/toast.svelte';

/** Time to display warning LFS (long text: 4 s of information toast is not enough to read it). */
export const LFS_TOAST_MS = 15_000;

let started = false;

/** Connects the guards (idempotent). Called by `register.ts`. */
export function startSafetyWatchers(): void {
  if (started) return;
  started = true;
  $effect.root(() => {
    const warned = new WeakSet<Session>();
    $effect(() => {
      const owner = activeSession.current;
      const info = repo.info;
      if (!info) {
        return;
      }
      if (!info.lfs || warned.has(owner)) return;
      warned.add(owner);
      untrack(() => toast.info(t('safety.lfs'), { timeoutMs: LFS_TOAST_MS }));
    });
  });
}
