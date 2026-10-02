// Flux « GitHub » (10) : github-login-dialog (Device Flow), github-repo-picker, github-menu, auth-required-dialog.
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { whenIdle } from '$lib/activity';
import DialogHost from '$lib/components/dialogs-base/DialogHost.svelte';
import '$lib/components/dialogs-base/register';
import PopoverHost from '$lib/components/menu/PopoverHost.svelte';
import ToastContainer from '$lib/components/toast/ToastContainer.svelte';
import '$lib/register-core';
import { openDialog } from '$lib/dialogs/registry';
import type { AppError, GithubLoginPoll, GithubRepo } from '$lib/ipc/types';
import { github } from '$lib/stores/github.svelte';
import { ui } from '$lib/stores/ui.svelte';
import { createFakeTransport } from '$lib/test/fake-transport';
import { resetAll } from '$lib/test/reset';
import { openTestRepo } from '../test-support';
import '../remotes/register';
import './register';
import GithubRepoPicker from './GithubRepoPicker.svelte';

vi.mock('$lib/feature-flags', () => ({ featureFlags: { githubLogin: true } }));

const tid = (id: string) => screen.getByTestId(id);
const maybe = (id: string) => screen.queryByTestId(id);

beforeEach(() => {
  resetAll({ keepRegistrations: true });
  vi.restoreAllMocks();
});

const START = { loginId: 'l1', userCode: 'ABCD-1234', verificationUri: 'http://127.0.0.1:5000/login/device', expiresIn: 900, interval: 1 };
const poll = (status: GithubLoginPoll['status'], login?: string): GithubLoginPoll => ({ status, interval: 1, login: login ?? null });
const repoOf = (fullName: string, over: Partial<GithubRepo> = {}): GithubRepo => ({
  fullName, cloneUrl: `http://h/${fullName}.git`, sshUrl: `git@h:${fullName}.git`, private: false, fork: false, description: null,
  updatedAt: '2026-01-01T00:00:00Z', defaultBranch: 'main', ...over,
});
const ALL = [repoOf('octo-test/alpha', { description: 'First' }), repoOf('octo-test/beta', { private: true }), repoOf('org/gamma', { fork: true })];

/** Successive answers for `github_login_poll` (the last one repeats). */
function pollSequence(seq: (GithubLoginPoll | AppError)[]) {
  let i = 0;
  return () => {
    const r = seq[Math.min(i++, seq.length - 1)]!;
    if ('code' in r) throw r;
    return r;
  };
}

describe('github-login-dialog (Device Flow)', () => {
  it("wait: code displayed and copied, page opened UNE times, contingencies chained, then account badge and closing after 1 s", async () => {
    const fake = await openTestRepo({
      github_login_start: () => START,
      github_login_poll: pollSequence([poll('pending'), poll('pending'), poll('success', 'octo-test')]),
      open_external: () => null,
    });
    const write = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
    render(DialogHost);
    const closed = openDialog<boolean>('github-login-dialog');
    const dlg = await screen.findByTestId('github-login-dialog');
    expect((await screen.findByTestId('github-device-code')).textContent).toBe('ABCD-1234');
    expect(dlg).toHaveAttribute('data-state', 'waiting');
    expect(write).toHaveBeenCalledWith('ABCD-1234');
    expect(fake.callsOf('open_external')).toHaveLength(1);
    expect(fake.callsOf('open_external')[0]!.args).toEqual({ target: { kind: 'url', url: START.verificationUri } });
    expect(tid('github-device-copy-btn')).toBeInTheDocument();
    expect(tid('github-device-open-btn')).toBeInTheDocument();

    await waitFor(() => expect(tid('github-login-dialog')).toHaveAttribute('data-state', 'success'));
    expect(fake.callsOf('github_login_poll')).toHaveLength(3);
    expect(fake.callsOf('github_login_poll')[0]!.args).toEqual({ loginId: 'l1' });
    expect(tid('github-account-badge')).toHaveTextContent('octo-test');
    expect(github.loggedIn).toBe(true);
    expect(github.login).toBe('octo-test');
    expect(await closed).toBe(true);
    expect(maybe('github-login-dialog')).toBeNull();
    // The verification page is not reopened by the following pollutants.
    expect(fake.callsOf('open_external')).toHaveLength(1);
  }, 6000);

  it("denied: github-login-error \"Authorization denied on GitHub.\" and github-login-retry-btn that restarts the stream", async () => {
    const fake = await openTestRepo({
      github_login_start: () => START,
      github_login_poll: pollSequence([poll('denied'), poll('pending'), poll('success', 'octo-test')]),
      open_external: () => null,
    });
    render(DialogHost);
    void openDialog('github-login-dialog');
    await waitFor(() => expect(maybe('github-login-dialog')).toHaveAttribute('data-state', 'denied'));
    expect(tid('github-login-error')).toHaveTextContent("Authorization refused on GitHub.");
    expect(github.loggedIn).toBe(false);
    await userEvent.click(tid('github-login-retry-btn'));
    await waitFor(() => expect(tid('github-login-dialog')).toHaveAttribute('data-state', 'success'), { timeout: 3000 });
    expect(fake.callsOf('github_login_start')).toHaveLength(2);
  });

  it("expires: \"The code has expired. Recommence the connection.\"", async () => {
    await openTestRepo({ github_login_start: () => START, github_login_poll: () => poll('expired'), open_external: () => null });
    render(DialogHost);
    void openDialog('github-login-dialog');
    await waitFor(() => expect(maybe('github-login-dialog')).toHaveAttribute('data-state', 'expired'));
    expect(tid('github-login-error')).toHaveTextContent("The code's expired, start the connection again.");
    expect(tid('github-login-retry-btn')).toBeInTheDocument();
  });

  it("NETWORK on startup: error status with backend message, without toast", async () => {
    const fake = await openTestRepo({ github_login_start: () => START });
    fake.on('github_login_start', () => {
      throw { code: 'NETWORK', message: "Cannot reach github.com. Check your connection.", details: {} } satisfies AppError;
    });
    render(DialogHost);
    render(ToastContainer);
    void openDialog('github-login-dialog');
    await waitFor(() => expect(maybe('github-login-dialog')).toHaveAttribute('data-state', 'error'));
    expect(tid('github-login-error')).toHaveTextContent("Could not sign in: Cannot reach github.com.");
    expect(maybe('toast')).toBeNull();
    expect(tid('github-login-retry-btn')).toBeInTheDocument();
  });

  it("OAuth error at poll (AUTH_REQUIRED oauth): error state", async () => {
    await openTestRepo({
      github_login_start: () => START,
      github_login_poll: pollSequence([{ code: 'AUTH_REQUIRED', message: "GitHub refused (device_flow_disabled).", details: { reason: 'oauth', oauthError: 'device_flow_disabled' } }]),
      open_external: () => null,
    });
    render(DialogHost);
    void openDialog('github-login-dialog');
    await waitFor(() => expect(maybe('github-login-dialog')).toHaveAttribute('data-state', 'error'));
    expect(tid('github-login-error')).toHaveTextContent('device_flow_disabled');
  });

  it("Cancel: dialog closes and loop stops (no more pollution)", async () => {
    let release: (p: GithubLoginPoll) => void = () => {};
    const fake = await openTestRepo({
      github_login_start: () => START,
      github_login_poll: () => new Promise<GithubLoginPoll>((r) => (release = r)),
      open_external: () => null,
    });
    render(DialogHost);
    const closed = openDialog<boolean>('github-login-dialog');
    await screen.findByTestId('github-device-code');
    await userEvent.click(tid('github-login-cancel-btn'));
    expect(await closed).toBe(false);
    expect(maybe('github-login-dialog')).toBeNull();
    release(poll('pending'));
    await whenIdle();
    expect(fake.callsOf('github_login_poll')).toHaveLength(1);
  });

  it("authorization completed after cancellation: the store follows (backend kept the token)", async () => {
    let release: (p: GithubLoginPoll) => void = () => {};
    await openTestRepo({
      github_login_start: () => START,
      github_login_poll: () => new Promise<GithubLoginPoll>((r) => (release = r)),
      open_external: () => null,
    });
    render(DialogHost);
    void openDialog('github-login-dialog');
    await screen.findByTestId('github-device-code');
    await userEvent.click(tid('github-login-cancel-btn'));
    release(poll('success', 'octo-test'));
    await waitFor(() => expect(github.login).toBe('octo-test'));
  });
});

describe('github-repo-picker', () => {
  async function mountPicker(handlers: Record<string, () => unknown>, onselect = vi.fn()) {
    const fake = await openTestRepo(handlers);
    render(DialogHost);
    render(GithubRepoPicker, { props: { onselect, selected: null } });
    return { fake, onselect };
  }

  it("connected: data-state=ready, lines with data-full-name, private / fork badges, selection", async () => {
    const { fake, onselect } = await mountPicker({
      github_status: () => ({ loggedIn: true, login: 'octo-test' }),
      github_repos: () => ({ repos: ALL, hasMore: false }),
    });
    await waitFor(() => expect(tid('github-repo-picker')).toHaveAttribute('data-state', 'ready'));
    const items = screen.getAllByTestId('github-repo-item');
    expect(items.map((e) => e.getAttribute('data-full-name'))).toEqual(['octo-test/alpha', 'octo-test/beta', 'org/gamma']);
    expect(items[1]).toHaveTextContent("Private");
    expect(items[2]).toHaveTextContent('fork');
    expect(fake.callsOf('github_repos')[0]!.args).toEqual({ page: 1, perPage: 100 });
    await userEvent.click(items[0]!);
    expect(onselect).toHaveBeenCalledWith(ALL[0]);
  });

  it("local filter on fullName and description", async () => {
    await mountPicker({ github_status: () => ({ loggedIn: true, login: 'o' }), github_repos: () => ({ repos: ALL, hasMore: false }) });
    await screen.findAllByTestId('github-repo-item');
    await userEvent.type(tid('github-repos-search-input'), 'ALPHA');
    expect(screen.getAllByTestId('github-repo-item')).toHaveLength(1);
    await userEvent.clear(tid('github-repos-search-input'));
    await userEvent.type(tid('github-repos-search-input'), 'first');
    expect(screen.getAllByTestId('github-repo-item')[0]).toHaveAttribute('data-full-name', 'octo-test/alpha');
    await userEvent.clear(tid('github-repos-search-input'));
    await userEvent.type(tid('github-repos-search-input'), 'zzz');
    expect(maybe('github-repo-item')).toBeNull();
  });

  it("pages as a hasMore: the first one will appear from the reception", async () => {
    const pages = [{ repos: [ALL[0]!], hasMore: true }, { repos: [ALL[1]!, ALL[2]!], hasMore: false }];
    let n = 0;
    const { fake } = await mountPicker({ github_status: () => ({ loggedIn: true, login: 'o' }), github_repos: () => pages[n++] });
    await waitFor(() => expect(screen.getAllByTestId('github-repo-item')).toHaveLength(3));
    expect(fake.callsOf('github_repos').map((c) => c.args.page)).toEqual([1, 2]);
  });

  it("Disconnected: data-state=logged-out with github-login-btn, no call github_repos", async () => {
    const { fake } = await mountPicker({ github_status: () => ({ loggedIn: false, login: null }) });
    await waitFor(() => expect(tid('github-repo-picker')).toHaveAttribute('data-state', 'logged-out'));
    expect(tid('github-login-btn')).toBeInTheDocument();
    expect(fake.callsOf('github_repos')).toHaveLength(0);
  });

  it("token revoked (AUTH_REQUIRED { github: true }): logged-out, store emptied, no authentication dialog (GH-04)", async () => {
    const fake = await openTestRepo({ github_status: () => ({ loggedIn: true, login: 'octo-test' }) });
    fake.reject('github_repos', { code: 'AUTH_REQUIRED', message: "session expired", details: { github: true } });
    render(DialogHost);
    render(GithubRepoPicker, { props: { onselect: vi.fn(), selected: null } });
    await waitFor(() => expect(tid('github-repo-picker')).toHaveAttribute('data-state', 'logged-out'));
    expect(github.loggedIn).toBe(false);
    expect(maybe('auth-required-dialog')).toBeNull();
    expect(tid('github-login-btn')).toBeInTheDocument();
  });

  it("network error: github-repos-error + github-repos-retry-btn that recharges", async () => {
    const fake = await openTestRepo({ github_status: () => ({ loggedIn: true, login: 'o' }) });
    fake.on('github_repos', () => ({ repos: ALL, hasMore: false }));
    fake.reject('github_repos', { code: 'NETWORK', message: 'Impossible de joindre api.github.com.', details: {} });
    render(DialogHost);
    render(GithubRepoPicker, { props: { onselect: vi.fn(), selected: null } });
    await waitFor(() => expect(tid('github-repo-picker')).toHaveAttribute('data-state', 'error'));
    expect(tid('github-repos-error')).toHaveTextContent("Could not load your repositories.");
    await userEvent.click(tid('github-repos-retry-btn'));
    await waitFor(() => expect(tid('github-repo-picker')).toHaveAttribute('data-state', 'ready'));
    expect(screen.getAllByTestId('github-repo-item')).toHaveLength(3);
  });

  it("connection from the selector: the store is connected, the list is loaded", async () => {
    await openTestRepo({
      github_status: () => ({ loggedIn: false, login: null }),
      github_login_start: () => START,
      github_login_poll: () => poll('success', 'octo-test'),
      github_repos: () => ({ repos: ALL, hasMore: false }),
      open_external: () => null,
    });
    render(DialogHost);
    render(GithubRepoPicker, { props: { onselect: vi.fn(), selected: null } });
    await userEvent.click(await screen.findByTestId('github-login-btn'));
    await waitFor(() => expect(github.loggedIn).toBe(true), { timeout: 3000 });
    await waitFor(() => expect(screen.getAllByTestId('github-repo-item')).toHaveLength(3), { timeout: 3000 });
  });
});

describe('github-menu (popover de toolbar-github-btn)', () => {
  async function openMenu(status: { loggedIn: boolean; login: string | null }, extra: Record<string, () => unknown> = {}) {
    const fake = await openTestRepo({ github_status: () => status, ...extra });
    render(DialogHost);
    render(PopoverHost);
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    await github.ensureLoaded();
    ui.openPopover('github-menu', anchor);
    await screen.findByTestId('github-menu');
    return fake;
  }

  it("connected: account badge, My repositories... (clone-dialog on the GitHub tab), Log out", async () => {
    const fake = await openMenu({ loggedIn: true, login: 'octo-test' }, { github_logout: () => null, github_repos: () => ({ repos: ALL, hasMore: false }) });
    expect(tid('github-account-badge')).toHaveTextContent('octo-test');
    expect(maybe('github-login-btn')).toBeNull();
    await userEvent.click(tid('github-repos-btn'));
    const clone = await screen.findByTestId('clone-dialog');
    expect(clone).toBeInTheDocument();
    expect(tid('github-repo-clone-btn')).toBeInTheDocument();
    expect(maybe('clone-submit-btn')).toBeNull();
    await userEvent.click(tid('clone-cancel-btn'));
    ui.openPopover('github-menu', document.body.querySelector('button')!);
    await screen.findByTestId('github-menu');
    await userEvent.click(tid('github-logout-btn'));
    await whenIdle();
    expect(fake.callsOf('github_logout')).toHaveLength(1);
    expect(github.loggedIn).toBe(false);
    expect(maybe('github-account-badge')).toBeNull();
  });

  it("Offline: github-login-btn opens github-login-dialog", async () => {
    await openMenu({ loggedIn: false, login: null }, { github_login_start: () => START, github_login_poll: () => poll('pending'), open_external: () => null });
    expect(maybe('github-account-badge')).toBeNull();
    await userEvent.click(tid('github-login-btn'));
    expect(await screen.findByTestId('github-login-dialog')).toBeInTheDocument();
    await userEvent.click(tid('github-login-cancel-btn'));
  });

  it("status is only read at the opening: no GitHub calls until the menu has been opened (never on startup)", async () => {
    const fake = createFakeTransport({ github_status: () => ({ loggedIn: false, login: null }) }).install();
    expect(fake.callsOf('github_status')).toHaveLength(0);
    expect(github.status).toBeNull();
    await github.ensureLoaded();
    await github.ensureLoaded();
    expect(fake.callsOf('github_status')).toHaveLength(1);
  });
});
