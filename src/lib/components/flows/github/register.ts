// Domain "GitHub" (10): Device Flow connection (`github-login-dialog`), account menu (`github-menu`), authentication required
// (`auth-required-dialog`, opened by `handleError` on `AUTH_REQUIRED`), publication of the open repository (`github-publish-dialog`, `github.publish`). The repositories selector (`GithubRepoPicker`) is a component
// shared by `remote-add-dialog` and `clone-dialog` (flows/remotes). The `github.login` action of the base opens `github-login-dialog`.
// Everything is sluggish loading (initial JS budget, `pnpm size`).
import { registerAction } from '$lib/actions/registry';
import { openDialog, registerDialog } from '$lib/dialogs/registry';
import { registerPopover } from '$lib/popovers/registry';
import { featureFlags } from '$lib/feature-flags';
import { t } from '$i18n/index';

if (featureFlags.githubLogin) {
  registerDialog('github-login-dialog', () => import('./GithubLoginDialog.svelte'));
  registerPopover('github-menu', () => import('./GithubMenu.svelte'));
  registerDialog('github-publish-dialog', () => import('./GithubPublishDialog.svelte'));
  registerAction({
    id: 'github.publish',
    label: () => t('github.publish.action'),
    disabledReason: (ctx) => (ctx.repoId === null ? t('action.noRepo') : ctx.op.blockReason('write')),
    run: async (ctx) => {
      await openDialog('github-publish-dialog', {}, ctx.session);
    },
  });
}
registerDialog('auth-required-dialog', () => import('./AuthRequiredDialog.svelte'));
