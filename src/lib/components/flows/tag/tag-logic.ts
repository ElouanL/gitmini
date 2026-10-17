// Pure logic of the tags flow: name checks, which remote a tag goes to, menu wording. The backend stays the authority
// (`INVALID_ARGUMENT`, `ALREADY_EXISTS`): these checks only spare a round trip for the obvious cases.
import { t } from '$i18n/index';
import type { RemoteInfo, TagInfo } from '$lib/ipc/types';
import { normalizeBranchInput, validateBranchName, type BranchNameProblem } from '../branches/names';

/** A tag name follows the same ref-format rules as a branch name: spaces typed become `-`. */
export const normalizeTagInput = normalizeBranchInput;

/** `null` if the name is accepted, otherwise the first rule it breaks. An empty name is `empty` (nothing to display). */
export const validateTagName = (name: string): BranchNameProblem | null => validateBranchName(name);

/** Message of a local problem. `null` for an empty name. */
export function tagProblemMessage(p: BranchNameProblem): string | null {
  if (p.reason === 'empty') return null;
  return t('tags.name.invalid', { reason: t(`branches.name.reason.${p.reason}`, { char: p.char ?? '' }) });
}

export type TagConflict = { kind: 'exists' } | { kind: 'blocked'; blockedBy: string };

/** The name is taken by a tag, or sits in the folder of one (`v1` against `v1/rc`), as `git` would refuse it. */
export function tagConflict(name: string, tags: readonly Pick<TagInfo, 'name'>[]): TagConflict | null {
  if (tags.some((tag) => tag.name === name)) return { kind: 'exists' };
  const blocker = tags.find((tag) => name.startsWith(`${tag.name}/`) || tag.name.startsWith(`${name}/`));
  return blocker ? { kind: 'blocked', blockedBy: blocker.name } : null;
}

export function conflictMessage(name: string, conflict: TagConflict): string {
  return conflict.kind === 'exists' ? t('tags.name.exists', { name }) : t('tags.name.blockedBy', { name, blockedBy: conflict.blockedBy });
}

/** Message for the backend's `ALREADY_EXISTS { what: "tag" }`. */
export function existsErrorMessage(name: string, details: Record<string, unknown> | null | undefined): string {
  const blockedBy = typeof details?.blockedBy === 'string' ? details.blockedBy : null;
  return conflictMessage(name, blockedBy ? { kind: 'blocked', blockedBy } : { kind: 'exists' });
}

export type PushPlan = { kind: 'none' } | { kind: 'single'; remote: string } | { kind: 'choose'; remote: string };

/** Where a tag goes: nowhere without a remote, straight to the only one, otherwise the user chooses (`origin` first). */
export function planTagPush(remotes: readonly Pick<RemoteInfo, 'name'>[]): PushPlan {
  if (remotes.length === 0) return { kind: 'none' };
  if (remotes.length === 1) return { kind: 'single', remote: remotes[0]!.name };
  return { kind: 'choose', remote: (remotes.find((r) => r.name === 'origin') ?? remotes[0]!).name };
}
