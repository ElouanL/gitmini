// Refusal of cherry_pick / revert_commit backend (09 "Preconditions"). `DIRTY_WORKTREE` and
// `UNTRACKED_WOULD_BE_OVERWRITTEN` keep the toasts of the base ("Stasher and try again").
// the zero managers between two tests (`resetErrorHandlers`), the tests remind it.
import { t, tp } from '$i18n/index';
import { registerErrorHandler } from '$lib/errors';
import { toast } from '$lib/stores/toast.svelte';
import { headBranchName } from '../branches/common';

export function registerPickErrorHandlers(): void {
  registerErrorHandler('INVALID_ARGUMENT', (e, ctx) => {
    if (ctx.command !== 'cherry_pick' && ctx.command !== 'revert_commit') return false;
    const details = e.details ?? {};
    if (details.field === 'oids' && details.reason === 'already-in-head') {
      const n = Array.isArray(details.oids) ? details.oids.length : 1;
      toast.error(tp('pick.error.alreadyInHead', n, { branch: headBranchName() ?? 'HEAD' }), { title: t('error.title.INVALID_ARGUMENT') });
      return true;
    }
    if (details.field === 'oids' && details.reason === 'not-in-head') {
      toast.error(t('pick.error.notInHead'), { title: t('error.title.INVALID_ARGUMENT') });
      return true;
    }
    if (details.field === 'head') {
      toast.error(t('pick.error.noHead'), { title: t('error.title.INVALID_ARGUMENT') });
      return true;
    }
    return false;
  });
}
