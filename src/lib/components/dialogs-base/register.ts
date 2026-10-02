import { registerDialog } from '$lib/dialogs/registry';

registerDialog('confirm', () => import('./ConfirmDialog.svelte'));
