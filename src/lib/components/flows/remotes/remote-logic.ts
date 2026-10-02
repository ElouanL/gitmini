// Pure logic of 10 (remote): validation of entries, decision table of the push, texts derived from refs, clone names.
// Backend remains the authority (`INVALID_ARGUMENT`, `ALREADY_EXISTS`): these functions avoid a aller-retour for obvious errors
// and set IU decisions (tested in remote-logic.test.ts).
import { t, tp } from '$i18n/index';
import type { BranchInfo, RefsSnapshot, RemoteInfo } from '$lib/ipc/types';

// ── Remotes : validation

export type RemoteNameProblem = 'empty' | 'leading-dash' | 'slash' | 'invalid';
export type RemoteUrlProblem = 'empty' | 'leading-dash';

/**
 * Remote name (10 §Remote management): valid ref component, without `/` or `-` initial.
 * Forbidden (`git check-ref-format`): control spaces and characters, `~ ^ : ? * [ \`, `..`, `@{`, `.` initial or final, `.lock` suffix.
 */
export function remoteNameProblem(name: string): RemoteNameProblem | null {
  if (name === '') return 'empty';
  if (name.startsWith('-')) return 'leading-dash';
  if (name.includes('/')) return 'slash';
  // eslint-disable-next-line no-control-regex
  if (/[\s~^:?*[\\\u0000-\u001f\u007f]/u.test(name)) return 'invalid';
  if (name.includes('..') || name.includes('@{') || name === '@') return 'invalid';
  if (name.startsWith('.') || name.endsWith('.') || name.endsWith('.lock')) return 'invalid';
  return null;
}

/** Remote URL: not empty and without initial `-` (never interpreted as an option). */
export function remoteUrlProblem(url: string): RemoteUrlProblem | null {
  const u = url.trim();
  if (u === '') return 'empty';
  if (u.startsWith('-')) return 'leading-dash';
  return null;
}

/** Pre-filled name: `origin` if it is free, otherwise `fallback` (owner's log on the GitHub tab), otherwise empty. */
export function defaultRemoteName(existing: readonly string[], fallback = ''): string {
  return existing.includes('origin') ? fallback : 'origin';
}

/** Name of repository of a clone URL: last segment without `.git` (`https://x/o/alpha.git`, `git@h:o/alpha.git`, `/tmp/alpha.git/`). */
export function repoNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/[\\/]+$/, '');
  const last = trimmed.split(/[\\/:]/).pop() ?? '';
  return last.replace(/\.git$/i, '');
}

/** `<directory>/<nom>` with the folder separator (`\` if the path contains it and no `/`). */
export function joinPath(parent: string, name: string): string {
  if (!name) return parent;
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  return `${parent.replace(/[\\/]+$/, '')}${sep}${name}`;
}

// "Push: decision table (10 §Push)
export type PushDecision =
  | { kind: 'detached' }
  | { kind: 'no-remote' }
  /** No upstream : `push-dialog` prefilled (`origin`, `<b>`, upstream checked). */
  | { kind: 'dialog'; remote: string }
  /** `behind = 0` (or `null`): push directly without a dialog. */
  | { kind: 'direct'; remote: string; remoteBranch: string; upToDate: boolean }
  /** `behind > 0` and `ahead > 0`: a single `confirm-dialog[data-action=force-push]` (N = `behind`). */
  | { kind: 'force'; remote: string; remoteBranch: string; ref: string; replaced: number }
  /** `behind > 0` and `ahead = 0`: show a Pull-first toast instead of pushing. */
  | { kind: 'behind'; ref: string };

/** Default remote: `origin`, if not the first. */
export function defaultPushRemote(remotes: readonly Pick<RemoteInfo, 'name'>[]): string | null {
  return remotes.find((r) => r.name === 'origin')?.name ?? remotes[0]?.name ?? null;
}

/** Remote name of the upstream (`origin/feature/x` on the remote `origin` → `feature/x`). */
export function upstreamBranchName(upstream: { ref: string; remote: string }, fallback: string): string {
  return upstream.ref.startsWith(`${upstream.remote}/`) ? upstream.ref.slice(upstream.remote.length + 1) : fallback;
}

export function decidePush(input: {
  /** Branch pushed; `null` if HEAD is detached and no branch is designated. */
  branch: Pick<BranchInfo, 'name' | 'upstream'> | null;
  remotes: readonly Pick<RemoteInfo, 'name'>[];
}): PushDecision {
  const { branch, remotes } = input;
  if (!branch) return { kind: 'detached' };
  if (remotes.length === 0) return { kind: 'no-remote' };
  const up = branch.upstream;
  if (!up) return { kind: 'dialog', remote: defaultPushRemote(remotes) ?? '' };
  const ahead = up.ahead ?? 0;
  const behind = up.behind ?? 0;
  const remoteBranch = upstreamBranchName(up, branch.name);
  if (behind > 0 && ahead > 0) return { kind: 'force', remote: up.remote, remoteBranch, ref: up.ref, replaced: behind };
  if (behind > 0) return { kind: 'behind', ref: up.ref };
  return { kind: 'direct', remote: up.remote, remoteBranch, upToDate: up.ahead === 0 && up.gone !== true };
}

/** Remote name entered in `push-dialog`: not empty, without space or initial `-`. */
export function remoteBranchProblem(name: string): 'empty' | 'invalid' | null {
  const n = name.trim();
  if (n === '') return 'empty';
  if (n.startsWith('-') || /\s/u.test(n)) return 'invalid';
  return null;
}

// - - Texts derived from the refs
/** `refs/remotes/<remote>/*` tracking branches removed with the remote (`git removes` also removes `branche.*.remote/merge` that point to it). */
export function remoteTrackingCount(refs: Pick<RefsSnapshot, 'remote'> | null, name: string): number {
  return (refs?.remote ?? []).filter((b) => b.remote === name).length;
}

/** Remote GitHub from a branch: that of its upstream, otherwise `origin` (same rule as `github_open_pr`, 10 §Open a PR). */
export function githubRemoteFor(
  branch: Pick<BranchInfo, 'upstream'> | null,
  remotes: readonly Pick<RemoteInfo, 'name' | 'isGithub'>[],
): string | null {
  const name = branch?.upstream?.remote ?? 'origin';
  return remotes.find((r) => r.name === name && r.isGithub)?.name ?? null;
}

/** Text from `confirm-dialog[data-action=remote-remove]`: "Delete the upstream remote and its N tracking branches?" */
export function remoteRemoveMessage(name: string, trackingBranches: number): string {
  if (trackingBranches === 0) return t('remotes.remove.message.none', { name });
  return tp('remotes.remove.message', trackingBranches, { name });
}

/** Text of `confirm-dialog[data-action=force-push]` (N = commits of the replaced server = `behind`). */
export function forcePushMessage(ref: string, replaced: number): string {
  return tp('remotes.forcePush.message', replaced, { ref });
}
