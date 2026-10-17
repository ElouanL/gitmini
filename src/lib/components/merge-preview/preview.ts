// Pure derivatives of a `merge_preview` answer: the one-line verdict, the label of each kind of conflict, and whether git
// would refuse the merge. Shared by the merge dialog and the menu shown after dropping a branch onto another.
import { t, tp } from '$i18n/index';
import type { MergeConflictKind, MergePreview, MergePreviewKind } from '$lib/ipc/types';

/** `ok`: nothing to worry about; `warn`: the merge will stop on conflicts; `error`: git refuses; `info`: nothing to show. */
export type PreviewTone = 'ok' | 'warn' | 'error' | 'info';

const TONES: Record<MergePreviewKind, PreviewTone> = {
  'up-to-date': 'info',
  'fast-forward': 'ok',
  clean: 'ok',
  conflicts: 'warn',
  unrelated: 'error',
  unsupported: 'info',
};

export function previewTone(p: MergePreview): PreviewTone {
  return TONES[p.kind];
}

/** The verdict as a sentence. */
export function previewSummary(p: MergePreview): string {
  switch (p.kind) {
    case 'up-to-date':
      return t('merge.preview.upToDate');
    case 'fast-forward':
      return t('merge.preview.ff');
    case 'clean':
      return t('merge.preview.clean');
    case 'conflicts':
      return p.conflictTotal > 0 ? tp('merge.preview.conflicts', p.conflictTotal) : t('merge.preview.conflicts.unknown');
    case 'unrelated':
      return t('merge.preview.unrelated');
    case 'unsupported':
      return t('merge.preview.unsupported');
  }
}

export function conflictKindLabel(kind: MergeConflictKind): string {
  return t(`merge.preview.kind.${kind}`);
}

/** Conflicted files beyond the ones listed (the backend caps the list). */
export function hiddenConflicts(p: MergePreview): number {
  return Math.max(0, p.conflictTotal - p.conflicts.length);
}

/** Git would refuse this merge whatever the mode, so the dialog must not offer it. */
export function blocksMerge(p: MergePreview | null): boolean {
  return p?.kind === 'unrelated';
}
