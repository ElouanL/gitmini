// Refusals of `branch_reset`. `DIRTY_WORKTREE` (a `keep` reset that would lose local changes) keeps the base toast.
import { t } from '$i18n/index';
import { registerErrorHandler } from '$lib/errors';
import { toast } from '$lib/stores/toast.svelte';

export function registerResetErrorHandlers(): void {
  registerErrorHandler('STALE', (e, ctx) => {
    if (ctx.command !== 'branch_reset' || e.details?.what !== 'head') return false;
    toast.error(t('reset.error.stale'), { title: t('error.title.STALE') });
    return true;
  });
  registerErrorHandler('DETACHED_HEAD', (_e, ctx) => {
    if (ctx.command !== 'branch_reset') return false;
    toast.error(t('reset.disabled.detached'), { title: t('error.title.DETACHED_HEAD') });
    return true;
  });
}
