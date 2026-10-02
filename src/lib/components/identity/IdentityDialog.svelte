<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { reportError: handleError, repo, session } = captureStores();
  // `identity-dialog` (05 "Identity") : name, e-mail, range (default global, or local). "Save" calls
  // `config_set_identity`, updates `commit-author` with the `Identity` returned and solves `true`: the base then restarts the
  // command that failed by `IDENTITY_MISSING` with the same arguments (`ctx.retry`).
  // Opened also by clicking on `commit-author` (props: `prefill`), without command to restart.
  import { commands } from '$lib/ipc/commands';
  import type { AppError, Identity } from '$lib/ipc/types';
  import type { DialogProps } from '$lib/dialogs/registry';

  import { t } from '$i18n/index';
  import DialogShell from '../dialogs-base/DialogShell.svelte';
  import { identityFieldError, validateIdentity, type IdentityScope } from './identity-logic';

  interface Props extends DialogProps<boolean> {
    /** Identity to be pre-filled (click on `commit-author`). */
    prefill?: Identity | null;
    /** Props injected by `handleError` when the dialog responds to `IDENTITY_MISSING` (not used here). */
    error?: AppError;
    command?: string;
    retry?: () => unknown;
    data?: Record<string, unknown>;
  }

  let { prefill = null, close }: Props = $props();

  // svelte-ignore state_referenced_locally
  let name = $state(prefill?.name ?? '');
  // svelte-ignore state_referenced_locally
  let email = $state(prefill?.email ?? '');
  // svelte-ignore state_referenced_locally
  let scope = $state<IdentityScope>(prefill?.scope === "local" ? "local" : "global");
  let nameError = $state<string | null>(null);
  let emailError = $state<string | null>(null);
  let formError = $state<string | null>(null);
  let saving = $state(false);

  async function save(): Promise<void> {
    if (saving) return;
    const v = validateIdentity(name, email);
    nameError = v.name ? t(`identity.error.${v.name}`) : null;
    emailError = v.email ? t(`identity.error.${v.email}`) : null;
    formError = null;
    if (!v.ok) return;
    const repoId = session.repoId;
    saving = true;
    try {
      const identity = await commands.configSetIdentity({
        ...(scope === "local" && repoId !== null ? { repoId } : {}),
        name: name.trim(),
        email: email.trim(),
        scope,
      });
      // `commit-author` reflects the returned identity.
      if (repo.info) repo.info = { ...repo.info, identity };
      close(true);
    } catch (e) {
      handleError(e, {
        command: 'config_set_identity',
        onError: (err) => {
          // Dialogue-specific error: under the target field, if not at the top of the form; the rest follows the routing of the base.
          const field = identityFieldError(err);
          if (field === 'name') nameError = err.message;
          else if (field === 'email') emailError = err.message;
          else if (err.code === 'INVALID_ARGUMENT' || err.code === 'GIT_FAILED') formError = err.message;
          else return false;
          return true;
        },
      });
    } finally {
      saving = false;
    }
  }
</script>

<DialogShell testid="identity-dialog" title={t('identity.title')} width={460} onclose={() => close()} onsubmit={() => void save()}>
  <p class="intro muted">{t('identity.intro')}</p>
  <div class="field">
    <label for="identity-name">{t('identity.name')}</label>
    <input id="identity-name" class="input" type="text" data-testid="identity-name-input" data-autofocus bind:value={name} aria-invalid={nameError ? 'true' : undefined} autocomplete="name" />
    {#if nameError}<span class="field-error" data-testid="identity-name-error">{nameError}</span>{/if}
  </div>
  <div class="field">
    <label for="identity-email">{t('identity.email')}</label>
    <input id="identity-email" class="input" type="email" data-testid="identity-email-input" bind:value={email} aria-invalid={emailError ? 'true' : undefined} autocomplete="email" />
    {#if emailError}<span class="field-error" data-testid="identity-email-error">{emailError}</span>{/if}
  </div>
  <div class="field">
    <label for="identity-scope">{t('identity.scope')}</label>
    <select id="identity-scope" class="select" data-testid="identity-scope-select" bind:value={scope}>
      <option value="global">{t('identity.scope.global')}</option>
      <option value="local" disabled={session.repoId === null}>{t('identity.scope.local')}</option>
    </select>
  </div>
  {#if formError}<p class="field-error" role="alert" data-testid="identity-error">{formError}</p>{/if}
  {#snippet footer()}
    <button type="button" class="btn" data-testid="identity-cancel-btn" onclick={() => close()}>{t('identity.cancel')}</button>
    <button type="button" class="btn btn-primary" data-testid="identity-save-btn" disabled={saving} onclick={() => void save()}>{t('identity.save')}</button>
  {/snippet}
</DialogShell>

<style>
  .intro {
    margin: 4px 0 12px;
  }
</style>
