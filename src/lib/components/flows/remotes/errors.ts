// Remote Domain Error Managers (`registerErrorHandler`): pull specific routing, before the base dialogs.
import { registerErrorHandler } from '$lib/errors/handle';
import { toast } from '$lib/stores/toast.svelte';
import { t } from '$i18n/index';

/**
 * A fast-forward that would overwrite local files (git refused: `details.stderr` present) has no autostash (10 §Pull 4): toast
 * "Commit or stash these files." The `DIRTY_WORKTREE` of a pull in rebase mode (backend pre-check, without stderr) is not taken
 * in charge here: the base opens `pull-autostash-dialog`.
 */
export function registerRemoteErrorHandlers(): () => void {
  return registerErrorHandler('DIRTY_WORKTREE', (err, ctx) => {
    if (ctx.command !== 'remote_pull' || typeof err.details?.stderr !== 'string') return false;
    const paths = Array.isArray(err.details.paths) ? (err.details.paths as unknown[]).filter((p): p is string => typeof p === 'string') : [];
    toast.error(t('remotes.toast.pullOverwritten', { paths: paths.join(', ') || "…" }), { title: t('error.title.DIRTY_WORKTREE') });
    return true;
  });
}
