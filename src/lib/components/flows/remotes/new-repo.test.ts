// New repository (`repo-init-dialog`) and publication on GitHub (`github-publish-dialog`). False backend + real dialogs and toasts.
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { whenIdle } from '$lib/activity';
import { runAction } from '$lib/actions/registry';
import DialogHost from '$lib/components/dialogs-base/DialogHost.svelte';
import '$lib/components/dialogs-base/register';
import ToastContainer from '$lib/components/toast/ToastContainer.svelte';
import '$lib/register-core';
import type { AppError, GithubRepo, RepoInfo } from '$lib/ipc/types';
import { github } from '$lib/stores/github.svelte';
import { repo } from '$lib/stores/repo.svelte';
import { makeRemotes, makeRepoInfo, makeStatus } from '$lib/test/fixtures';
import { resetAll } from '$lib/test/reset';
import { openTestRepo } from '../test-support';
import '../github/register';
import './register';
import { registerRemoteErrorHandlers } from './errors';

vi.mock('$lib/feature-flags', () => ({ featureFlags: { githubLogin: true } }));

const tid = (id: string) => screen.getByTestId(id);
const err = (code: AppError['code'], details: Record<string, unknown> = {}, message: string = code): AppError => ({ code, message, details });

const created: GithubRepo = {
  fullName: 'octo-test/fresh', cloneUrl: 'https://github.com/octo-test/fresh.git', sshUrl: 'git@github.com:octo-test/fresh.git',
  private: true, fork: false, description: null, updatedAt: '', defaultBranch: 'main',
};

beforeEach(() => {
  resetAll({ keepRegistrations: true });
  registerRemoteErrorHandlers();
});

async function setup(handlers: Record<string, (a: Record<string, unknown>) => unknown> = {}, info: Partial<RepoInfo> = {}) {
  const fake = await openTestRepo({
    github_status: () => ({ loggedIn: true, login: 'octo-test' }),
    github_orgs: () => ['org'],
    github_create_repo: () => created,
    remote_add: () => ({ ...makeRemotes()[0]!, name: 'origin', fetchUrl: created.cloneUrl, pushUrl: created.cloneUrl }),
    remote_push: () => null,
    ...handlers,
  }, info);
  render(DialogHost);
  render(ToastContainer);
  await whenIdle();
  return fake;
}

describe('new repository (repo-init-dialog)', () => {
  it('repo_init, opens the new repository, then commits every file in it', async () => {
    const info = makeRepoInfo({ id: 7, name: 'fresh', workdir: '/tmp/dev/fresh', head: { branch: 'main', oid: null, detached: false, unborn: true } });
    const fake = await setup({
      repo_init: () => info,
      stage_paths: () => makeStatus(),
      commit_create: () => ({ oid: 'c'.repeat(40), status: makeStatus({ files: [] }) }),
    });
    void runAction('repo.init');
    await screen.findByTestId('repo-init-dialog');
    await userEvent.type(tid('repo-init-path-input'), '/tmp/dev/fresh');
    await userEvent.click(tid('repo-init-submit-btn'));
    await waitFor(() => expect(repo.id).toBe(7));
    await whenIdle();
    expect(fake.callsOf('repo_init')[0]!.args).toEqual({ path: '/tmp/dev/fresh', initialBranch: 'main', readme: true });
    expect(fake.callsOf('stage_paths')[0]!.args).toEqual({ repoId: 7, paths: 'all' });
    expect(fake.callsOf('commit_create')[0]!.args).toMatchObject({ repoId: 7, summary: 'Initial commit', amend: false });
    expect(repo.tabs).toHaveLength(2);
  });

  it('already a repository: error under the folder, no commit', async () => {
    const fake = await setup();
    void runAction('repo.init');
    await screen.findByTestId('repo-init-dialog');
    await userEvent.click(tid('repo-init-submit-btn'));
    expect(tid('repo-init-error')).toHaveTextContent('Choose a folder.');
    await userEvent.type(tid('repo-init-path-input'), '/tmp/existing');
    fake.reject('repo_init', err('ALREADY_EXISTS', { what: 'repo', path: '/tmp/existing' }));
    await userEvent.click(tid('repo-init-submit-btn'));
    await whenIdle();
    expect(tid('repo-init-error')).toHaveTextContent('/tmp/existing is already a Git repository');
    expect(fake.callsOf('commit_create')).toHaveLength(0);
  });
});

describe('publish on GitHub (github-publish-dialog)', () => {
  it('creates the repository for an organization, adds origin and pushes the branch with upstream', async () => {
    const fake = await setup({}, { name: 'fresh' });
    github.setLoggedIn('octo-test');
    void runAction('github.publish');
    await screen.findByTestId('github-publish-dialog');
    await waitFor(() => expect(screen.getByRole('option', { name: 'org' })).toBeInTheDocument());
    expect((tid('github-publish-name-input') as HTMLInputElement).value).toBe('fresh');
    await userEvent.selectOptions(tid('github-publish-owner-select'), 'org');
    await userEvent.click(tid('github-publish-submit-btn'));
    await whenIdle();
    expect(fake.callsOf('github_create_repo')[0]!.args).toEqual({ owner: 'org', name: 'fresh', private: true, description: null });
    expect(fake.callsOf('remote_add')[0]!.args).toEqual({ repoId: 1, name: 'origin', url: created.cloneUrl });
    expect(fake.callsOf('remote_push')[0]!.args).toMatchObject({ repoId: 1, remote: 'origin', branch: 'main', setUpstream: true, forceWithLease: false });
    await waitFor(() => expect(screen.queryByTestId('github-publish-dialog')).toBeNull());
    expect(screen.getByText('octo-test/fresh published on GitHub')).toBeInTheDocument();
  });

  it('name taken (ALREADY_EXISTS github-repo): error under the name, nothing else runs', async () => {
    const fake = await setup({}, { name: 'fresh' });
    github.setLoggedIn('octo-test');
    fake.reject('github_create_repo', err('ALREADY_EXISTS', { what: 'github-repo', field: 'name' }));
    void runAction('github.publish');
    await screen.findByTestId('github-publish-dialog');
    await userEvent.click(tid('github-publish-submit-btn'));
    await whenIdle();
    expect(tid('github-publish-error')).toHaveTextContent('fresh already exists on this account.');
    expect(fake.callsOf('remote_add')).toHaveLength(0);
    expect(fake.callsOf('remote_push')).toHaveLength(0);
  });

  it('no commit yet: creates and adds the remote without pushing', async () => {
    const fake = await setup(
      { refs_list: () => ({ head: { kind: 'unborn', name: 'main' }, local: [], remote: [], tags: [] }) },
      { name: 'fresh', head: { branch: 'main', oid: null, detached: false, unborn: true } },
    );
    github.setLoggedIn('octo-test');
    void runAction('github.publish');
    await screen.findByTestId('github-publish-dialog');
    expect(tid('github-publish-hint')).toHaveTextContent('Nothing to push yet');
    await userEvent.click(tid('github-publish-submit-btn'));
    await whenIdle();
    expect(fake.callsOf('remote_add')).toHaveLength(1);
    expect(fake.callsOf('remote_push')).toHaveLength(0);
  });
});
