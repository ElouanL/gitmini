// Domain "GitHub" (10): Device Flow connection (`github-login-dialog`), account menu (`github-menu`), authentication required
// (`auth-required-dialog`, opened by `handleError` on `AUTH_REQUIRED`). The repositories selector (`GithubRepoPicker`) is a component
// shared by `remote-add-dialog` and `clone-dialog` (flows/remotes). The `github.login` action of the base opens `github-login-dialog`.
// Everything is sluggish loading (initial JS budget, `pnpm size`).
import { registerDialog } from '$lib/dialogs/registry';
import { registerPopover } from '$lib/popovers/registry';
import { featureFlags } from '$lib/feature-flags';

if (featureFlags.githubLogin) {
  registerDialog('github-login-dialog', () => import('./GithubLoginDialog.svelte'));
  registerPopover('github-menu', () => import('./GithubMenu.svelte'));
}
registerDialog('auth-required-dialog', () => import('./AuthRequiredDialog.svelte'));
