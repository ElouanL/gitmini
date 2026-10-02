// / 10: no access to the keychain or call GitHub at the start of the application or at the opening of a repository.
// `github_status` is only read when opening the account menu (or a stream that needs it).
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../../../App.svelte';
import { whenIdle } from '$lib/activity';
import { bootstrap } from '$lib/bootstrap';
import { unwireEvents } from '$lib/stores/wiring';
import { createFakeTransport, type FakeTransport } from '$lib/test/fake-transport';
import { makeAppInfo, makeLogPage, makeRecents, makeRefs, makeRemotes, makeRepoInfo, makeStashes, makeStatus, makeUndo } from '$lib/test/fixtures';
import { resetAll } from '$lib/test/reset';
import '$lib/register-core';
import '$lib/register-domains';

vi.mock('$lib/feature-flags', () => ({ featureFlags: { githubLogin: true } }));

const GITHUB_COMMANDS = ['github_status', 'github_login_start', 'github_login_poll', 'github_logout', 'github_repos', 'github_open_pr'];

let fake: FakeTransport;

function backend(over: Record<string, () => unknown> = {}): FakeTransport {
  return createFakeTransport({
    app_info: () => makeAppInfo(),
    settings_get: () => ({}),
    settings_set: () => null,
    repo_recent_list: () => makeRecents(),
    repo_open: () => makeRepoInfo(),
    repo_close: () => null,
    log_page: () => makeLogPage(),
    refs_list: () => makeRefs(),
    remote_list: () => makeRemotes(),
    stash_list: () => makeStashes(),
    status_get: () => makeStatus(),
    undo_peek: () => makeUndo(),
    github_status: () => ({ loggedIn: true, login: 'octo-test' }),
    ...over,
  }).install();
}

const githubCalls = () => fake.calls.filter((c) => GITHUB_COMMANDS.includes(c.command)).map((c) => c.command);

beforeEach(() => {
  resetAll({ keepRegistrations: true });
});
afterEach(() => unwireEvents());

describe("starting without GitHub (10, 02 §6)", () => {
  it("home screen: no call GitHub", async () => {
    fake = backend({ settings_get: () => ({ 'workspace.tabs': { paths: [], activePath: null } }) });
    render(App);
    await bootstrap();
    await screen.findByTestId('welcome-open-btn');
    expect(screen.getByTestId('welcome-github-login-btn')).toBeInTheDocument();
    await whenIdle();
    expect(githubCalls()).toEqual([]);
  });

  it("start with a repository (gitmini <path>) and open a recent repository: no call GitHub", async () => {
    fake = backend({ app_info: () => makeAppInfo({ initialPath: '/r' }) });
    render(App);
    await bootstrap();
    await screen.findByTestId('toolbar-repo-name');
    await whenIdle();
    expect(fake.callsOf('repo_open')).toHaveLength(1);
    expect(githubCalls()).toEqual([]);
  });

  it("the status is read only when the account menu is opened (only once)", async () => {
    fake = backend({ app_info: () => makeAppInfo({ initialPath: '/r' }) });
    render(App);
    await bootstrap();
    await screen.findByTestId('toolbar-github-btn');
    await whenIdle();
    expect(githubCalls()).toEqual([]);

    await userEvent.click(screen.getByTestId('toolbar-github-btn'));
    expect(await screen.findByTestId('github-account-badge')).toHaveTextContent('octo-test');
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByTestId('toolbar-github-btn'));
    await screen.findByTestId('github-account-badge');
    expect(githubCalls()).toEqual(['github_status']);
  });
});
