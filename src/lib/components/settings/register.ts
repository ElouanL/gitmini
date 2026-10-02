import { registerDialog } from '$lib/dialogs/registry';

registerDialog('settings-dialog', () => import('./SettingsDialog.svelte'));
