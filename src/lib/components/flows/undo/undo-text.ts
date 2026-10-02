// Texts of the undo , derived from the `UndoEntry` backend. Pure logic, tested (undo-text.test.ts).
//
// The entry only holds `kind`, `label`, `refName`, `before`, `after`, `stashMessage`, `upstreamRef`: the summary of the commit,
// the incoming branch of a merge and the number of commits of a cherry-pick are read in `label`
// ("Cancel commit "feat: x"", "Cancel feature merge in hand", "Cancel cherry-pick of 3 commits").
// A wording that does not follow these forms gives a generic sentence rather than a hole in the text.
import { t, tp } from '$i18n/index';
import type { UndoEntry } from '$lib/ipc/types';

export function shortSha(oid: string | null | undefined): string {
  return oid ? oid.slice(0, 7) : '';
}

/** `refs/heads/feature` → `feature`. */
export function branchOf(entry: Pick<UndoEntry, 'refName'>): string {
  return entry.refName?.replace(/^refs\/heads\//, '') ?? '';
}

/** First text enters "" in the wording (the summary of the commit, the message of the stash). */
export function quotedIn(label: string): string | null {
  const m = /["«]\s*(.*)\s*["»]\s*$/u.exec(label) ?? /["«]\s*(.*)\s*["»]/u.exec(label);
  return m && m[1] ? m[1] : null;
}

/** "Cancel feature merge in hand" → `feature`. */
export function incomingIn(label: string): string | null {
  const m = /\b(?:Undo|Cancel)\s+(.+?)\s+merge\s+(?:into|in)\s+\S+\s*$/u.exec(label);
  return m && m[1] ? m[1] : null;
}

/** "Cancel the cherry-pick of 3 commits" → 3; one commit (or unknown wording) → 1. */
export function commitCountIn(label: string): number {
  const m = /\b(\d+)\s+commits?\b/u.exec(label);
  const n = m ? Number(m[1]) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Text of `undo-confirm-description`. The backend already writes the full sentence in `UndoEntry.effect` ("Cancel commit "x"; the
 * (a) The amendment remains indexed.') `effect` which is not a sentence (empty, keyword) gives the text derived from
 */
export function undoDescription(entry: UndoEntry): string {
  const effect = entry.effect.trim();
  if (/\s/u.test(effect)) return effect;
  return derivedDescription(entry);
}

/** Text reconstructed from `kind`, `label`, `refName`, `before`... (reply). */
export function derivedDescription(entry: UndoEntry): string {
  const branch = branchOf(entry);
  const sha = shortSha(entry.before);
  switch (entry.kind) {
    case 'commit': {
      const summary = quotedIn(entry.label);
      return summary ? t("undo.confirm.description.commit", { summary }) : t("undo.confirm.description.commit.noSummary");
    }
    case 'amend':
      return sha ? t("undo.confirm.description.amend", { sha }) : t("undo.confirm.description.amend.noSha");
    case 'merge': {
      const incoming = incomingIn(entry.label);
      return incoming
        ? t("undo.confirm.description.merge", { incoming, branch, sha })
        : t("undo.confirm.description.merge.noIncoming", { branch, sha });
    }
    case 'rebase':
      return t("undo.confirm.description.rebase", { branch, sha });
    case 'cherry-pick':
    case 'revert':
      return tp("undo.confirm.description.pick", commitCountIn(entry.label), { kind: t(`undo.kind.${entry.kind}`), branch, sha });
    case 'pull':
      return entry.upstreamRef
        ? t("undo.confirm.description.pull", { branch, sha, upstream: entry.upstreamRef })
        : t("undo.confirm.description.pull.noUpstream", { branch, sha });
    case 'branch-delete':
      return t("undo.confirm.description.branch-delete", { branch, sha });
    case 'stash-drop':
      return t("undo.confirm.description.stash-drop", { message: entry.stashMessage ?? quotedIn(entry.label) ?? '' });
    default:
      return t('undo.confirm.fallback', { label: entry.label });
  }
}
