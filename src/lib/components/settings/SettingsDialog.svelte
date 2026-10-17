<script lang="ts">
  // Settings (03): `settings-dialog`, `settings-theme-select`, `settings-pull-mode-select`, `settings-editor-command-input`,
  // `settings-graph-dim-unreachable-checkbox`, `settings-proxy-mode-select`, `settings-proxy-url-input`, `settings-close-btn`. Each change calls `settings_set` (debum 300 ms).
  import type { DialogProps } from '$lib/dialogs/registry';
  import { onMount } from 'svelte';
  import { updates } from '$lib/updates/global.svelte';
  import type { ProxyModeSetting, PullModeSetting, ThemeSetting } from '$lib/ipc/settings-types';
  import { app } from '$lib/stores/app.svelte';
  import { t } from '$i18n/index';
  import DialogShell from '../dialogs-base/DialogShell.svelte';

  let { close }: DialogProps<void> = $props();

  let editorDraft = $state(app.get('editor.command') ?? '');
  let editorError = $state<string | null>(null);
  let editorToken = 0;

  let proxyDraft = $state(app.get('network.proxy.url') ?? '');
  let proxyError = $state<string | null>(null);
  let proxyToken = 0;
  const PROXY_URL = /^(https?|socks5h?):\/\/[^\s/?#]+\/?$/i;

  const theme = $derived(app.get('theme'));
  const proxyMode = $derived(app.get('network.proxy.mode'));
  const pullMode = $derived(app.get('pull.mode'));
  const dim = $derived(app.get('graph.dimUnreachable'));
  onMount(() => { void updates.refresh(); });

  function closeDialog(): void {
    void app.flush();
    close();
  }

  function onEditorInput(): void {
    const value = editorDraft.trim();
    const token = ++editorToken;
    if (value !== '' && !value.includes('{path}')) {
      // Local validation: an order without {path} is never sent.
      editorError = t('settings.editorCommand.missingPath');
      return;
    }
    editorError = null;
    void app.set('editor.command', value === '' ? null : value, { optimistic: false }).then((err) => {
      if (token === editorToken) editorError = err ? err.message : null;
    });
  }

  function onProxyInput(): void {
    const value = proxyDraft.trim();
    const token = ++proxyToken;
    if (value !== '' && !PROXY_URL.test(value)) {
      // Local validation: an obviously invalid URL is never sent (the backend checks it again).
      proxyError = t('settings.proxy.invalid');
      return;
    }
    proxyError = null;
    void app.set('network.proxy.url', value === '' ? null : value, { optimistic: false }).then((err) => {
      if (token === proxyToken) proxyError = err ? err.message : null;
    });
  }
</script>

<DialogShell testid="settings-dialog" title={t('settings.title')} width={480} onclose={closeDialog}>
  <div class="field">
    <label for="settings-theme">{t('settings.theme')}</label>
    <select
      id="settings-theme"
      class="select"
      data-testid="settings-theme-select"
      value={theme}
      onchange={(e) => void app.set('theme', e.currentTarget.value as ThemeSetting)}
    >
      <option value="system">{t('settings.theme.system')}</option>
      <option value="light">{t('settings.theme.light')}</option>
      <option value="dark">{t('settings.theme.dark')}</option>
    </select>
  </div>

  <div class="field">
    <label for="settings-pull-mode">{t('settings.pullMode')}</label>
    <select
      id="settings-pull-mode"
      class="select"
      data-testid="settings-pull-mode-select"
      value={pullMode}
      onchange={(e) => void app.set('pull.mode', e.currentTarget.value as PullModeSetting)}
    >
      <option value="ff-only">{t('settings.pullMode.ff-only')}</option>
      <option value="rebase">{t('settings.pullMode.rebase')}</option>
    </select>
  </div>

  <div class="field">
    <label for="settings-editor">{t('settings.editorCommand')}</label>
    <input
      id="settings-editor"
      class="input mono"
      data-testid="settings-editor-command-input"
      type="text"
      spellcheck="false"
      autocomplete="off"
      placeholder={t('settings.editorCommand.placeholder')}
      aria-invalid={editorError ? 'true' : 'false'}
      aria-describedby="settings-editor-hint"
      bind:value={editorDraft}
      oninput={onEditorInput}
    />
    {#if editorError}
      <div class="field-error" data-testid="settings-editor-command-error" role="alert">{editorError}</div>
    {/if}
    <div class="muted hint" id="settings-editor-hint">{t('settings.editorCommand.hint')}</div>
  </div>

  <div class="field">
    <label class="checkbox">
      <input
        type="checkbox"
        data-testid="settings-graph-dim-unreachable-checkbox"
        checked={dim}
        onchange={(e) => void app.set('graph.dimUnreachable', e.currentTarget.checked)}
      />
      <span>{t('settings.dimUnreachable')}</span>
    </label>
  </div>

  <div class="field">
    <label for="settings-proxy-mode">{t('settings.proxy')}</label>
    <select
      id="settings-proxy-mode"
      class="select"
      data-testid="settings-proxy-mode-select"
      value={proxyMode}
      aria-describedby="settings-proxy-hint"
      onchange={(e) => void app.set('network.proxy.mode', e.currentTarget.value as ProxyModeSetting)}
    >
      <option value="system">{t('settings.proxy.system')}</option>
      <option value="none">{t('settings.proxy.none')}</option>
      <option value="manual">{t('settings.proxy.manual')}</option>
    </select>
    {#if proxyMode === 'manual'}
      <input
        id="settings-proxy-url"
        class="input mono"
        data-testid="settings-proxy-url-input"
        type="text"
        spellcheck="false"
        autocomplete="off"
        aria-label={t('settings.proxy.url')}
        placeholder={t('settings.proxy.url.placeholder')}
        aria-invalid={proxyError ? 'true' : 'false'}
        bind:value={proxyDraft}
        oninput={onProxyInput}
      />
      {#if proxyError}
        <div class="field-error" data-testid="settings-proxy-url-error" role="alert">{proxyError}</div>
      {/if}
    {/if}
    <div class="muted hint" id="settings-proxy-hint">{t('settings.proxy.hint')}</div>
  </div>

  {#snippet footer()}
    <button type="button" class="btn btn-primary" data-testid="settings-close-btn" onclick={closeDialog}>{t('settings.close')}</button>
  {/snippet}

  <section class="updates" aria-label={t('updates.title')}>
    <strong>{t('updates.title')}</strong>
    <p data-testid="settings-app-version">{t('updates.currentVersion', { version: app.info?.version ?? '—' })}</p>
    <label class="checkbox">
      <input type="checkbox" data-testid="settings-updates-auto-checkbox" checked={app.get('updates.auto')}
        disabled={!updates.view.status.enabled}
        onchange={(e) => void app.set('updates.auto', e.currentTarget.checked)} />
      <span>{t('updates.automatic')}</span>
    </label>
    <p class="muted" data-testid="settings-update-status" role="status">{updates.message}</p>
    {#if updates.view.status.notes}<p class="notes" data-testid="settings-update-notes">{updates.view.status.notes}</p>{/if}
    <button type="button" class="btn" data-testid="settings-update-check-btn"
      disabled={!updates.view.status.enabled || ['checking', 'downloading', 'installing'].includes(updates.view.status.phase)}
      onclick={() => void updates.check()}>{t('updates.check')}</button>
  </section>
</DialogShell>

<style>
  .hint {
    font-size: 12px;
  }
  .checkbox {
    font-weight: 400;
    color: var(--fg);
    font-size: 13px;
  }
  .updates { border-top: 1px solid var(--border); padding-top: 16px; font-size: 13px; }
  .updates p { margin: 8px 0; }
  .notes { white-space: pre-wrap; max-height: 120px; overflow: auto; }
</style>
