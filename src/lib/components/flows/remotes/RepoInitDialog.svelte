<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { runWrite } = captureStores();
  import { repo } from '$lib/stores/repo.svelte';
  // `repo-init-dialog` (10 §Remote and clone): opened by `welcome-init-btn` / `repo-tabs-init-btn` / `repo.init`. Folder (absolute path,
  // "Browse..." fills it; absent folder is created, existing files are kept), initial branch (`main`), `README.md`. `repo_init` opens the
  // new repository; then optional first commit of every file (`stage_paths all` + `commit_create`, in the new tab: `IDENTITY_MISSING`
  // goes through `identity-dialog`) and, with GitHub login enabled, `github-publish-dialog`.
  import type { DialogProps } from '$lib/dialogs/registry';
  import { commands } from '$lib/ipc/commands';
  import { featureFlags } from '$lib/feature-flags';
  import { hasDialog } from '$lib/dialogs/registry';
  import { pickFolder } from '$lib/ipc/dialog';
  import type { AppError } from '$lib/ipc/types';
  import { toast } from '$lib/stores/toast.svelte';
  import { t } from '$i18n/index';
  import DialogShell from '$lib/components/dialogs-base/DialogShell.svelte';

  let { close }: DialogProps<boolean> = $props();

  let path = $state('');
  let branch = $state('main');
  let readme = $state(true);
  let initialCommit = $state(true);
  let publish = $state(false);
  let busy = $state(false);
  let error = $state<{ field: 'path' | 'branch'; message: string } | null>(null);

  const canPublish = featureFlags.githubLogin && hasDialog('github-publish-dialog');

  async function browse(): Promise<void> {
    const chosen = await pickFolder(t('remotes.init.browseTitle'));
    if (!chosen) return;
    path = chosen;
    if (error?.field === 'path') error = null;
  }

  async function submit(): Promise<void> {
    if (busy) return;
    const target = path.trim();
    if (target === '') {
      error = { field: 'path', message: t('remotes.init.error.path.empty') };
      return;
    }
    busy = true;
    error = null;
    const res = await runWrite(
      t('remotes.op.init'),
      () => commands.repoInit({ path: target, initialBranch: branch.trim() || null, readme }),
      {
        command: 'repo_init',
        onError: (e: AppError) => {
          if (e.code === 'ALREADY_EXISTS' && e.details?.what === 'repo') {
            error = { field: 'path', message: t('remotes.init.error.path.repo', { path: String(e.details.path ?? target) }) };
            return true;
          }
          if (e.code === 'ALREADY_EXISTS' || (e.code === 'INVALID_ARGUMENT' && e.details?.field === 'path')) {
            error = { field: 'path', message: e.message };
            return true;
          }
          if (e.code === 'INVALID_ARGUMENT' && e.details?.field === 'initialBranch') {
            error = { field: 'branch', message: e.message };
            return true;
          }
          return false;
        },
      },
    );
    busy = false;
    if (!res.ok) return;
    close(true);
    const info = res.value;
    repo.adopt(info);
    toast.success(t('remotes.toast.initialized', { name: info.name }));

    // From here on, the new tab is the active session.
    const created = captureStores();
    if (initialCommit) {
      const committed = await created.runWrite(
        t('remotes.op.initialCommit'),
        async () => {
          await commands.stagePaths({ repoId: info.id, paths: 'all' });
          const r = await commands.commitCreate({ repoId: info.id, summary: t('remotes.init.commitMessage'), amend: false });
          created.status.apply(r.status);
          return r;
        },
        { command: 'commit_create' },
      );
      if (!committed.ok) return;
    }
    if (publish && canPublish) await created.openDialog('github-publish-dialog');
  }
</script>

<DialogShell testid="repo-init-dialog" title={t('remotes.init.title')} width={520} onclose={() => close()} onsubmit={() => void submit()}>
  <div class="field">
    <label for="repo-init-path">{t('remotes.init.path')}</label>
    <div class="row">
      <input
        id="repo-init-path"
        class="input"
        data-testid="repo-init-path-input"
        data-autofocus
        placeholder={t('remotes.init.path.placeholder')}
        disabled={busy}
        aria-invalid={error?.field === 'path' ? 'true' : undefined}
        bind:value={path}
        oninput={() => {
          if (error?.field === 'path') error = null;
        }}
      />
      <button type="button" class="btn" data-testid="repo-init-browse-btn" disabled={busy} onclick={() => void browse()}>{t('remotes.clone.browse')}</button>
    </div>
    {#if error?.field === 'path'}<span class="field-error" data-testid="repo-init-error" role="alert">{error.message}</span>{/if}
  </div>
  <div class="field">
    <label for="repo-init-branch">{t('remotes.init.branch')}</label>
    <input
      id="repo-init-branch"
      class="input"
      data-testid="repo-init-branch-input"
      disabled={busy}
      aria-invalid={error?.field === 'branch' ? 'true' : undefined}
      bind:value={branch}
      oninput={() => {
        if (error?.field === 'branch') error = null;
      }}
    />
    {#if error?.field === 'branch'}<span class="field-error" data-testid="repo-init-branch-error" role="alert">{error.message}</span>{/if}
  </div>
  <label class="checkbox">
    <input type="checkbox" data-testid="repo-init-readme-toggle" disabled={busy} bind:checked={readme} />
    {t('remotes.init.readme')}
  </label>
  <label class="checkbox">
    <input type="checkbox" data-testid="repo-init-commit-toggle" disabled={busy} bind:checked={initialCommit} />
    {t('remotes.init.initialCommit')}
  </label>
  {#if canPublish}
    <label class="checkbox">
      <input type="checkbox" data-testid="repo-init-publish-toggle" disabled={busy || !initialCommit} bind:checked={publish} />
      {t('remotes.init.publish')}
    </label>
  {/if}

  {#snippet footer()}
    <button type="button" class="btn" data-testid="repo-init-cancel-btn" disabled={busy} onclick={() => close()}>{t('remotes.clone.cancel')}</button>
    <button type="button" class="btn btn-primary" data-testid="repo-init-submit-btn" disabled={busy} onclick={() => void submit()}>{t('remotes.init.submit')}</button>
  {/snippet}
</DialogShell>

<style>
  .row {
    display: flex;
    gap: 6px;
  }
</style>
