<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { reportError, op, runWrite } = captureStores();
  import { repo } from '$lib/stores/repo.svelte';
  // `clone-dialog` (10 §Remote and clone): Opened by `welcome-clone-btn` / `repo.clone` (Tab URL) or `github-repos-btn` (Tab GitHub).
  // Destination: absolute editable path (`clone-dest-input`, empty at opening); "Browse..." (native selector, input out of Tauri)
  // fills `<chosen folder>/<repository name>`. `repo_clone` [L] then opens the cloned repository. During the clone the dialog displays the
  // progress and `clone-cancel-btn` cancel the operation (the home screen does not have a toolbar).
  import type { DialogProps } from '$lib/dialogs/registry';

  import { commands } from '$lib/ipc/commands';
  import { featureFlags } from '$lib/feature-flags';
  import { pickFolder } from '$lib/ipc/dialog';
  import type { AppError, GithubRepo } from '$lib/ipc/types';

  import { toast } from '$lib/stores/toast.svelte';
  import { t } from '$i18n/index';
  import DialogShell from '$lib/components/dialogs-base/DialogShell.svelte';
  import GithubRepoPicker from '../github/GithubRepoPicker.svelte';
  import { repoUrl, shortNameOf } from '../github/github-repos';
  import { joinPath, remoteUrlProblem, repoNameFromUrl } from './remote-logic';

  interface Props extends DialogProps<boolean> {
    tab?: 'url' | 'github';
  }

  let { tab: initialTab = 'url', close }: Props = $props();

  type Tab = 'url' | 'github';
  // svelte-ignore state_referenced_locally
  let tab = $state<Tab>(featureFlags.githubLogin ? initialTab : 'url');
  let url = $state('');
  let protocol = $state<'https' | 'ssh'>('https');
  let selected = $state.raw<GithubRepo | null>(null);
  let dest = $state('');
  /** Parent folder chosen by "Browse...": `dest` follows the name of the repository until the user edits it. */
  let parent = $state('');
  let destAuto = $state(true);
  let busy = $state(false);
  let error = $state<{ field: 'url' | 'dest' | 'repo'; message: string } | null>(null);

  const cloneUrl = $derived(tab === 'url' ? url.trim() : selected ? repoUrl(selected, protocol) : '');
  const repoName = $derived(tab === 'url' ? repoNameFromUrl(url) : selected ? shortNameOf(selected.fullName) : '');

  $effect(() => {
    if (destAuto && parent) dest = joinPath(parent, repoName);
  });

  const progress = $derived(op.inflight?.opId ? op.inflight : null);
  const progressText = $derived.by(() => {
    if (!progress) return t('remotes.clone.running');
    const base = progress.progressLabel ?? progress.label;
    return progress.percent !== null ? `${base} ${Math.round(progress.percent)} %` : base;
  });

  async function browse(): Promise<void> {
    const chosen = await pickFolder(t('remotes.clone.browseTitle'));
    if (!chosen) return;
    parent = chosen;
    destAuto = true;
    dest = joinPath(chosen, repoName);
  }

  function pick(r: GithubRepo): void {
    selected = r;
    error = null;
  }

  async function cancelClone(): Promise<void> {
    const id = op.inflight?.opId;
    if (!id) return;
    try {
      await commands.opCancel({ opId: id });
    } catch (e) {
      reportError(e, { command: 'op_cancel' });
    }
  }

  async function submit(): Promise<void> {
    if (busy) return;
    if (tab === 'github' && !selected) {
      error = { field: 'repo', message: t('remotes.clone.error.pickRepo') };
      return;
    }
    const urlProblem = remoteUrlProblem(cloneUrl);
    if (urlProblem) {
      error = { field: 'url', message: t(urlProblem === 'empty' ? 'remotes.clone.error.url.empty' : 'remotes.clone.error.url.invalid') };
      return;
    }
    const target = dest.trim();
    if (target === '') {
      error = { field: 'dest', message: t('remotes.clone.error.dest.empty') };
      return;
    }
    busy = true;
    error = null;
    const res = await runWrite(
      t('remotes.op.clone'),
      ({ opId }) => commands.repoClone({ opId: opId!, url: cloneUrl, dest: target }),
      {
        long: true,
        command: 'repo_clone',
        onError: (e: AppError) => {
          if (e.code === 'ALREADY_EXISTS' && e.details?.what === 'dest') {
            error = { field: 'dest', message: t('remotes.clone.error.dest.exists', { path: String(e.details.path ?? target) }) };
            return true;
          }
          if (e.code === 'INVALID_ARGUMENT' && e.details?.field === 'url') {
            error = { field: 'url', message: e.message };
            return true;
          }
          return false;
        },
      },
    );
    busy = false;
    if (!res.ok) return;
    close(true);
    repo.adopt(res.value);
    toast.success(t('remotes.toast.cloned', { name: res.value.name }));
  }
</script>

<DialogShell testid="clone-dialog" title={t('remotes.clone.title')} width={520} onclose={() => close()} onsubmit={() => void submit()}>
  <div class="tabs" role="tablist">
    <button type="button" role="tab" class="tab" class:active={tab === 'url'} aria-selected={tab === 'url'} disabled={busy} data-testid="clone-tab-url" onclick={() => { tab = 'url'; error = null; }}>{t('remotes.clone.tab.url')}</button>
    {#if featureFlags.githubLogin}
      <button type="button" role="tab" class="tab" class:active={tab === 'github'} aria-selected={tab === 'github'} disabled={busy} data-testid="clone-tab-github" onclick={() => { tab = 'github'; error = null; }}>{t('remotes.clone.tab.github')}</button>
    {/if}
  </div>

  {#if tab === 'url'}
    <div class="field">
      <label for="clone-url">{t('remotes.clone.url')}</label>
      <input
        id="clone-url"
        class="input"
        data-testid="clone-url-input"
        data-autofocus
        disabled={busy}
        aria-invalid={error?.field === 'url' ? 'true' : undefined}
        bind:value={url}
        oninput={() => {
          if (error?.field === 'url') error = null;
        }}
      />
      {#if error?.field === 'url'}<span class="field-error" data-testid="clone-error" role="alert">{error.message}</span>{/if}
    </div>
  {:else}
    <div class="field">
      <GithubRepoPicker selected={selected?.fullName ?? null} onselect={pick} />
      {#if error?.field === 'repo'}<span class="field-error" data-testid="clone-error" role="alert">{error.message}</span>{/if}
    </div>
    <div class="field">
      <label for="clone-protocol">{t('remotes.clone.protocol')}</label>
      <select id="clone-protocol" class="select" data-testid="clone-protocol-select" disabled={busy} bind:value={protocol}>
        <option value="https">https</option>
        <option value="ssh">ssh</option>
      </select>
    </div>
  {/if}

  <div class="field">
    <label for="clone-dest">{t('remotes.clone.dest')}</label>
    <div class="row">
      <input
        id="clone-dest"
        class="input"
        data-testid="clone-dest-input"
        placeholder={t('remotes.clone.dest.placeholder')}
        disabled={busy}
        aria-invalid={error?.field === 'dest' ? 'true' : undefined}
        bind:value={dest}
        oninput={() => {
          destAuto = false;
          if (error?.field === 'dest') error = null;
        }}
      />
      <button type="button" class="btn" data-testid="clone-dest-browse-btn" disabled={busy} onclick={() => void browse()}>{t('remotes.clone.browse')}</button>
    </div>
    {#if error?.field === 'dest'}<span class="field-error" data-testid="clone-dest-error" role="alert">{error.message}</span>{/if}
  </div>

  {#if busy}
    <div class="progress" data-testid="clone-progress" role="status">
      <span class="bar" style:width="{progress?.percent ?? 0}%"></span>
      <span class="progress-text truncate">{progressText}</span>
    </div>
  {/if}

  {#snippet footer()}
    {#if busy}
      <button type="button" class="btn" data-testid="clone-cancel-btn" onclick={() => void cancelClone()}>{t('remotes.clone.cancelRunning')}</button>
    {:else}
      <button type="button" class="btn" data-testid="clone-cancel-btn" onclick={() => close()}>{t('remotes.clone.cancel')}</button>
    {/if}
    {#if tab === 'url'}
      <button type="button" class="btn btn-primary" data-testid="clone-submit-btn" disabled={busy} onclick={() => void submit()}>{t('remotes.clone.submit')}</button>
    {:else}
      <button type="button" class="btn btn-primary" data-testid="github-repo-clone-btn" disabled={busy} onclick={() => void submit()}>{t('remotes.clone.submit')}</button>
    {/if}
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
  .row {
    display: flex;
    gap: 6px;
  }
  .progress {
    position: relative;
    height: 24px;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
  }
  .bar {
    position: absolute;
    inset: 0 auto 0 0;
    background: var(--row-selected);
    transition: width 0.15s linear;
  }
  .progress-text {
    position: relative;
    display: block;
    padding: 0 8px;
    line-height: 22px;
    font-size: 12px;
  }
</style>
