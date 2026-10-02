// Wording of `op-banner-progress`: one text per situation, according to 07 (rebase) and 09 (cherry-pick / revert) ; merges according to 03/06.
import type { RepoOpState } from '../../ipc/types';
import { t, tp } from '../../../i18n/index';

export function shortSha(oid: string | null): string {
  return oid ? oid.slice(0, 7) : '';
}

function branchName(headName: string | null, fallback: string | null): string {
  if (headName) return headName.replace(/^refs\/heads\//, '');
  return fallback ?? t('banner.detachedHead');
}

function commitRef(st: RepoOpState): string {
  if (!st.stoppedAt) return t('banner.currentCommit');
  const sha = shortSha(st.stoppedAt);
  return st.currentSummary ? t('banner.commitRef', { sha, summary: st.currentSummary }) : t('banner.commitRef.noSummary', { sha });
}

/** `3/7`; `null` if `total` is unknown ("step omitted"). */
export function stepText(st: RepoOpState): string | null {
  return st.step !== null && st.total !== null ? `${st.step}/${st.total}` : null;
}

/** Banner text for the `st` state. `currentBranch` = branch of HEAD. */
export function bannerLabel(st: RepoOpState, currentBranch: string | null = null): string {
  const step = stepText(st);
  const sep = ' — ';
  const conflicts = st.conflictedPaths.length;

  switch (st.kind) {
    case 'am':
      return t('banner.am');

    case 'rebase': {
      const head = branchName(st.headName, currentBranch);
      const onto = st.ontoLabel ?? (st.onto ? shortSha(st.onto) : null);
      const base = onto ? t('banner.rebase', { head, onto }) : t('banner.rebase.noOnto', { head });
      if (st.phase === 'running') return `${[base, step].filter(Boolean).join(sep)}…`;
      const tail = (() => {
        if (st.phase === 'conflict') {
          if (conflicts > 0) {
            return [t('banner.conflictAt', { commit: commitRef(st) }), tp('banner.filesInConflict', conflicts)].join(sep);
          }
          return t('banner.resolved');
        }
        if (st.stopReason === 'empty') return t('banner.rebase.empty', { commit: commitRef(st) });
        return t('banner.rebase.blocked', { commit: commitRef(st) });
      })();
      return [base, step, tail].filter(Boolean).join(sep);
    }

    case 'merge': {
      const head = currentBranch ?? branchName(st.headName, null);
      const base = st.incoming ? t('banner.merge', { incoming: st.incoming.replace(/^refs\/heads\//, ''), head }) : t('banner.merge.noIncoming', { head });
      if (st.phase === 'running') return `${base}${t('banner.running')}`;
      return [base, conflicts > 0 ? tp('banner.mergeConflict', conflicts) : t('banner.resolved.merge')].join(sep);
    }

    case 'cherry-pick':
    case 'revert': {
      if (st.stopReason === 'stale') return t('banner.stale');
      const base = t(st.kind === 'cherry-pick' ? 'banner.cherry-pick' : 'banner.revert');
      if (st.phase === 'running') return `${[base, step].filter(Boolean).join(sep)}…`;
      const tail = (() => {
        if (st.phase === 'conflict') {
          if (conflicts > 0) {
            return [t('banner.conflictAt', { commit: commitRef(st) }), tp('banner.filesInConflict', conflicts)].join(sep);
          }
          return t('banner.resolved');
        }
        if (st.stopReason === 'empty') return t('banner.pick.empty', { commit: commitRef(st) });
        return t('banner.pick.blocked', { commit: commitRef(st) });
      })();
      return [base, step, tail].filter(Boolean).join(sep);
    }
  }
}

/** Buttons proposed by the banner (03 + 07 + 09). */
export function bannerButtons(st: RepoOpState): { continue: boolean; skip: boolean; abort: boolean } {
  switch (st.kind) {
    case 'am':
      return { continue: false, skip: false, abort: true };
    case 'merge':
      return { continue: true, skip: false, abort: true };
    case 'rebase':
      return { continue: st.stopReason !== 'empty', skip: true, abort: true };
    case 'cherry-pick':
    case 'revert':
      return {
        continue: st.stopReason !== 'empty' && st.stopReason !== 'stale',
        skip: st.stopReason !== 'stale',
        abort: true,
      };
  }
}
