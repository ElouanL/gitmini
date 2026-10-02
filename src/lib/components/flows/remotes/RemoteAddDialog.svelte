<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { refs, runWrite, session } = captureStores();
  // `remote-add-dialog` (10 §Remote and clone): opened by `sidebar-remote-add-btn`. Tab URL (`remote-add-tab-url`) or GitHub
  // (`remote-add-tab-github`, repositories selector + https/ssh protocol). Default name `origin` if it is free, otherwise empty
  // (Tab GitHub: the owner). `remote_add`; if "fetch after addition" is checked, `remote_fetch` of the new remote.
  import type { DialogProps } from '$lib/dialogs/registry';
  import { commands } from '$lib/ipc/commands';
  import { featureFlags } from '$lib/feature-flags';
  import type { AppError, GithubRepo } from '$lib/ipc/types';

  import { t } from '$i18n/index';
  import DialogShell from '$lib/components/dialogs-base/DialogShell.svelte';
  import GithubRepoPicker from '../github/GithubRepoPicker.svelte';
  import { ownerOf, repoUrl } from '../github/github-repos';
  import { defaultRemoteName, remoteNameProblem, remoteUrlProblem } from './remote-logic';
  import { fetchNamed } from './sync';

  let { close }: DialogProps<boolean> = $props();

  type Tab = 'url' | 'github';
  const existing = $derived(refs.remotes.map((r) => r.name));

  let tab = $state<Tab>('url');
  let name = $state(defaultRemoteName(refs.remotes.map((r) => r.name)));
  let nameTouched = $state(false);
  let url = $state('');
  let protocol = $state<'https' | 'ssh'>('https');
  let fetchAfter = $state(true);
  let selected = $state.raw<GithubRepo | null>(null);
  let busy = $state(false);
  let error = $state<{ field: 'name' | 'url' | 'repo'; message: string } | null>(null);

  function pick(repo: GithubRepo): void {
    selected = repo;
    error = null;
    if (!nameTouched) name = defaultRemoteName(existing, ownerOf(repo.fullName));
  }

  function setTab(next: Tab): void {
    tab = next;
    error = null;
  }

  async function submit(): Promise<void> {
    if (busy) return;
    const repoId = session.repoId;
    if (repoId === null) return;
    const trimmed = name.trim();
    const nameProblem = remoteNameProblem(trimmed);
    if (nameProblem) {
      error = { field: 'name', message: t(`remotes.add.error.name.${nameProblem}`) };
      return;
    }
    let target: string;
    if (tab === 'github') {
      if (!selected) {
        error = { field: 'repo', message: t('remotes.add.error.pickRepo') };
        return;
      }
      target = repoUrl(selected, protocol);
    } else {
      const urlProblem = remoteUrlProblem(url);
      if (urlProblem) {
        error = { field: 'url', message: t(`remotes.add.error.url.${urlProblem}`) };
        return;
      }
      target = url.trim();
    }
    busy = true;
    error = null;
    const res = await runWrite(t('remotes.op.remoteAdd'), () => commands.remoteAdd({ repoId, name: trimmed, url: target }), {
      command: 'remote_add',
      onError: (e: AppError) => {
        if (e.code === 'ALREADY_EXISTS' && e.details?.what === 'remote') {
          error = { field: 'name', message: t('remotes.add.error.exists', { name: String(e.details.name ?? trimmed) }) };
          return true;
        }
        if (e.code === 'INVALID_ARGUMENT' && (e.details?.field === 'name' || e.details?.field === 'url')) {
          error = { field: e.details.field, message: e.message };
          return true;
        }
        return false;
      },
    });
    busy = false;
    if (!res.ok) return;
    void refs.reloadRemotes();
    close(true);
    if (fetchAfter) void fetchNamed(trimmed, session);
  }
</script>

<DialogShell testid="remote-add-dialog" title={t('remotes.add.title')} width={500} onclose={() => close()} onsubmit={() => void submit()}>
  <div class="tabs" role="tablist">
    <button type="button" role="tab" class="tab" class:active={tab === 'url'} aria-selected={tab === 'url'} data-testid="remote-add-tab-url" onclick={() => setTab('url')}>{t('remotes.add.tab.url')}</button>
    {#if featureFlags.githubLogin}
      <button type="button" role="tab" class="tab" class:active={tab === 'github'} aria-selected={tab === 'github'} data-testid="remote-add-tab-github" onclick={() => setTab('github')}>{t('remotes.add.tab.github')}</button>
    {/if}
  </div>

  {#if tab === 'github'}
    <div class="field">
      <GithubRepoPicker selected={selected?.fullName ?? null} onselect={pick} />
      {#if error?.field === 'repo'}<span class="field-error" data-testid="remote-add-error" role="alert">{error.message}</span>{/if}
    </div>
    <div class="field">
      <label for="remote-add-protocol">{t('remotes.add.protocol')}</label>
      <select id="remote-add-protocol" class="select" data-testid="remote-add-protocol-select" bind:value={protocol}>
        <option value="https">https</option>
        <option value="ssh">ssh</option>
      </select>
    </div>
  {/if}

  <div class="field">
    <label for="remote-add-name">{t('remotes.add.name')}</label>
    <input
      id="remote-add-name"
      class="input"
      data-testid="remote-add-name-input"
      data-autofocus
      aria-invalid={error?.field === 'name' ? 'true' : undefined}
      bind:value={name}
      oninput={() => {
        nameTouched = true;
        if (error?.field === 'name') error = null;
      }}
    />
    {#if error?.field === 'name'}<span class="field-error" data-testid="remote-add-error" role="alert">{error.message}</span>{/if}
  </div>

  {#if tab === 'url'}
    <div class="field">
      <label for="remote-add-url">{t('remotes.add.url')}</label>
      <input
        id="remote-add-url"
        class="input"
        data-testid="remote-add-url-input"
        aria-invalid={error?.field === 'url' ? 'true' : undefined}
        bind:value={url}
        oninput={() => {
          if (error?.field === 'url') error = null;
        }}
      />
      {#if error?.field === 'url'}<span class="field-error" data-testid="remote-add-error" role="alert">{error.message}</span>{/if}
    </div>
  {/if}

  <label class="checkbox">
    <input type="checkbox" data-testid="remote-add-fetch-checkbox" bind:checked={fetchAfter} />
    {t('remotes.add.fetch')}
  </label>

  {#snippet footer()}
    <button type="button" class="btn" data-testid="remote-add-cancel-btn" onclick={() => close()}>{t('remotes.add.cancel')}</button>
    <button type="button" class="btn btn-primary" data-testid="remote-add-submit-btn" disabled={busy} onclick={() => void submit()}>{t('remotes.add.submit')}</button>
  {/snippet}
</DialogShell>

<style>
  .tabs {
    display: flex;
    gap: 2px;
    margin-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }
  .tab {
    padding: 6px 12px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: var(--fg-muted);
  }
  .tab.active {
    color: var(--fg);
    border-bottom-color: var(--accent);
    font-weight: 600;
  }
</style>
