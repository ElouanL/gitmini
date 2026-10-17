<script lang="ts">
  import { captureStores } from '$lib/stores/context';
  const { repo: current, refs, runWrite, session, openDialog } = captureStores();
  // `github-publish-dialog` (10 §GitHub): opened by `github.publish` (GitHub menu, `repo-init-dialog`, `remote-add-dialog`).
  // Owner (account or organization, `github_orgs`), name (from the folder), description, private by default. On submit:
  // `github_create_repo` (empty repository) → `remote_add` (`origin` if free) → `remote_push { setUpstream }` [L] of the current branch,
  // unless the branch has no commit yet. Logged out: `github-publish-login-btn` opens `github-login-dialog`.
  import { onMount } from 'svelte';
  import type { DialogProps } from '$lib/dialogs/registry';
  import { commands } from '$lib/ipc/commands';
  import type { AppError, GithubRepo } from '$lib/ipc/types';
  import { github } from '$lib/stores/github.svelte';
  import { toast } from '$lib/stores/toast.svelte';
  import { reportError } from '$lib/errors/report';
  import { t } from '$i18n/index';
  import DialogShell from '$lib/components/dialogs-base/DialogShell.svelte';
  import { publishRemoteName, repoNameProblem, suggestRepoName } from './publish';

  let { close }: DialogProps<boolean> = $props();

  let owner = $state('');
  let orgs = $state.raw<string[]>([]);
  let name = $state(suggestRepoName(current.info?.name ?? ''));
  let description = $state('');
  let isPrivate = $state(true);
  let busy = $state(false);
  let error = $state<{ field: 'name' | 'form'; message: string } | null>(null);

  const branch = $derived(current.head?.detached ? null : (current.head?.branch ?? null));
  const unborn = $derived(current.head?.unborn ?? false);
  const canPush = $derived(branch !== null && !unborn);
  const remoteName = $derived(publishRemoteName(refs.remotes.map((r) => r.name)));

  async function loadOrgs(): Promise<void> {
    if (!github.loggedIn) return;
    try {
      orgs = await commands.githubOrgs();
    } catch (e) {
      reportError(e, { command: 'github_orgs', quiet: true });
    }
  }

  onMount(() => {
    void github.ensureLoaded().then(loadOrgs);
  });

  async function login(): Promise<void> {
    await openDialog('github-login-dialog');
    await loadOrgs();
  }

  async function submit(): Promise<void> {
    if (busy || !github.loggedIn) return;
    const repoId = session.repoId;
    if (repoId === null) return;
    const trimmed = name.trim();
    const problem = repoNameProblem(trimmed);
    if (problem) {
      error = { field: 'name', message: t(`github.publish.error.name.${problem}`) };
      return;
    }
    busy = true;
    error = null;
    const remote = remoteName;
    const push = canPush ? branch : null;
    let created: GithubRepo | null = null;
    const res = await runWrite(
      t('github.publish.op'),
      async ({ opId }) => {
        created = await commands.githubCreateRepo({
          owner: owner || null, name: trimmed, private: isPrivate, description: description.trim() || null,
        });
        await commands.remoteAdd({ repoId, name: remote, url: created.cloneUrl });
        if (push) {
          await commands.remotePush({ repoId, opId: opId!, remote, branch: push, setUpstream: true, forceWithLease: false });
        }
        return created;
      },
      {
        long: true,
        command: 'github_create_repo',
        onError: (e: AppError) => {
          if (e.code === 'ALREADY_EXISTS' && e.details?.what === 'github-repo') {
            error = { field: 'name', message: t('github.publish.error.name.exists', { name: trimmed }) };
            return true;
          }
          if (e.code === 'INVALID_ARGUMENT' && !created) {
            error = { field: e.details?.field === 'name' ? 'name' : 'form', message: e.message };
            return true;
          }
          return false;
        },
      },
    );
    busy = false;
    // Created but remote or push failed: the GitHub repository exists, the remote may too.
    if (created) {
      void refs.reloadRemotes();
      void refs.reloadRefs();
    }
    if (!res.ok) return;
    close(true);
    toast.success(t(push ? 'github.publish.toast.pushed' : 'github.publish.toast.created', { name: res.value.fullName }));
  }
</script>

<DialogShell testid="github-publish-dialog" title={t('github.publish.title')} width={500} onclose={() => close()} onsubmit={() => void submit()}>
  {#if github.status === null}
    <p class="muted">{t('github.menu.loading')}</p>
  {:else if !github.loggedIn}
    <p class="muted" data-testid="github-publish-logged-out">{t('github.publish.loggedOut')}</p>
  {:else}
    <div class="field">
      <label for="github-publish-owner">{t('github.publish.owner')}</label>
      <select id="github-publish-owner" class="select" data-testid="github-publish-owner-select" disabled={busy} bind:value={owner}>
        <option value="">{github.login ?? t('github.publish.ownerMe')}</option>
        {#each orgs as org (org)}
          <option value={org}>{org}</option>
        {/each}
      </select>
    </div>
    <div class="field">
      <label for="github-publish-name">{t('github.publish.name')}</label>
      <input
        id="github-publish-name"
        class="input"
        data-testid="github-publish-name-input"
        data-autofocus
        disabled={busy}
        aria-invalid={error?.field === 'name' ? 'true' : undefined}
        bind:value={name}
        oninput={() => {
          if (error?.field === 'name') error = null;
        }}
      />
      {#if error?.field === 'name'}<span class="field-error" data-testid="github-publish-error" role="alert">{error.message}</span>{/if}
    </div>
    <div class="field">
      <label for="github-publish-description">{t('github.publish.description')}</label>
      <input id="github-publish-description" class="input" data-testid="github-publish-description-input" disabled={busy} bind:value={description} />
    </div>
    <div class="field visibility" role="radiogroup" aria-label={t('github.publish.visibility')}>
      <label class="checkbox">
        <input type="radio" name="github-publish-visibility" data-testid="github-publish-private-radio" disabled={busy} checked={isPrivate} onchange={() => (isPrivate = true)} />
        {t('github.publish.private')}
      </label>
      <label class="checkbox">
        <input type="radio" name="github-publish-visibility" data-testid="github-publish-public-radio" disabled={busy} checked={!isPrivate} onchange={() => (isPrivate = false)} />
        {t('github.publish.public')}
      </label>
    </div>
    <p class="muted hint" data-testid="github-publish-hint">
      {#if canPush}
        {t('github.publish.hint.push', { branch: branch ?? '', remote: remoteName })}
      {:else}
        {t('github.publish.hint.noCommit', { remote: remoteName })}
      {/if}
    </p>
    {#if error?.field === 'form'}<p class="field-error" data-testid="github-publish-error" role="alert">{error.message}</p>{/if}
  {/if}

  {#snippet footer()}
    <button type="button" class="btn" data-testid="github-publish-cancel-btn" disabled={busy} onclick={() => close()}>{t('github.publish.cancel')}</button>
    {#if github.status !== null && !github.loggedIn}
      <button type="button" class="btn btn-primary" data-testid="github-publish-login-btn" onclick={() => void login()}>{t('github.menu.login')}</button>
    {:else}
      <button type="button" class="btn btn-primary" data-testid="github-publish-submit-btn" disabled={busy || !github.loggedIn} onclick={() => void submit()}>
        {t('github.publish.submit')}
      </button>
    {/if}
  {/snippet}
</DialogShell>

<style>
  .visibility {
    display: flex;
    gap: 16px;
  }
  .hint {
    margin: 4px 0 0;
    font-size: 12px;
  }
</style>
