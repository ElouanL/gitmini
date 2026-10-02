import { activeSession, type Session } from '../stores/session.svelte';
// Message from `merge_continue` launched from `op-banner-continue-btn` (03): it is that of `commit-form[data-mode=merge]` (05).
// The working tree domain records a provider; without it, the default git message is used.
import type { RepoOpState } from '../ipc/types';

type Provider = (owner: Session) => string | null;

let provider: Provider | null = null;

export function registerMergeMessageProvider(fn: Provider | null): void {
  provider = fn;
}

export function getMergeMessage(state: RepoOpState, head: string | null, owner: Session = activeSession.current): string {
  const custom = provider?.(owner);
  if (custom && custom.trim()) return custom;
  const incoming = state.incoming?.replace(/^refs\/heads\//, '') ?? 'HEAD';
  return head ? `Merge branch '${incoming}' into ${head}` : `Merge branch '${incoming}'`;
}
