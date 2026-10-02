// Remote streams (10): push (decision table, force-push, push-dialog), releases, pull (divergencing, autostash), authentication,
// addition / deletion of remote, clone, opening of a PR. False backend + real dialogues and toasts.
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { whenIdle } from '$lib/activity';
import { runAction } from '$lib/actions/registry';
import DialogHost from '$lib/components/dialogs-base/DialogHost.svelte';
import '$lib/components/dialogs-base/register';
import ToastContainer from '$lib/components/toast/ToastContainer.svelte';
import '$lib/register-core';
import { openDialog } from '$lib/dialogs/registry';
import { resolveMenu } from '$lib/menus/registry';
import type { AppError, BranchInfo, RefsSnapshot, RemoteInfo } from '$lib/ipc/types';
import { op } from '$lib/stores/op.svelte';
import { refs } from '$lib/stores/refs.svelte';
import { repo } from '$lib/stores/repo.svelte';
import { makeRefs, makeRemotes, makeRepoInfo } from '$lib/test/fixtures';
import { resetAll } from '$lib/test/reset';
import { openTestRepo } from '../test-support';
import '../github/register';
import './register';
import { registerRemoteErrorHandlers } from './errors';

vi.mock('$lib/feature-flags', () => ({ featureFlags: { githubLogin: true } }));

const tid = (id: string) => screen.getByTestId(id);
const maybe = (id: string) => screen.queryByTestId(id);

beforeEach(() => {
  resetAll({ keepRegistrations: true });
  registerRemoteErrorHandlers();
});

function refsWith(main: Partial<BranchInfo>): RefsSnapshot {
  const base = makeRefs();
  return { ...base, local: base.local.map((b) => (b.name === 'main' ? { ...b, ...main } : b)) };
}
const upstream = (ahead: number | null, behind: number | null) => ({ ref: 'origin/main', remote: 'origin', ahead, behind, gone: false });
const err = (code: AppError['code'], details: Record<string, unknown> = {}, message: string = code): AppError => ({ code, message, details });

async function setup(handlers: Record<string, () => unknown> = {}, snapshot: RefsSnapshot = makeRefs()) {
  const fake = await openTestRepo({ refs_list: () => snapshot, remote_list: () => makeRemotes(), remote_push: () => null, remote_pull: () => ({ head: { branch: 'main', oid: 'b'.repeat(40), detached: false, unborn: false } }), remote_fetch: () => null, ...handlers });
  render(DialogHost);
  render(ToastContainer);
  await whenIdle();
  return fake;
}

describe("push: decision table (10 § Push)", () => {
  it("behind > 0 and ahead > 0 : UN confirm force-push (danger, focus on Cancel, N = behind) ; Cancel → none push", async () => {
    const fake = await setup();
    void runAction('git.push');
    const dlg = await screen.findByTestId('confirm-dialog');
    expect(dlg).toHaveAttribute('data-action', 'force-push');
    expect(dlg).toHaveAttribute('data-danger', 'true');
    expect(dlg).toHaveTextContent("2 commits present on the server will be replaced");
    expect(tid('confirm-dialog-cancel-btn')).toHaveFocus();
    await userEvent.click(tid('confirm-dialog-cancel-btn'));
    await whenIdle();
    expect(fake.callsOf('remote_push')).toHaveLength(0);
    expect(maybe('confirm-dialog')).toBeNull();
  });

  it("confirm: remote_push with forceWithLease, remote and remote branch of l upstream", async () => {
    const fake = await setup();
    void runAction('git.push');
    await userEvent.click(await screen.findByTestId('confirm-dialog-confirm-btn'));
    await whenIdle();
    expect(fake.callsOf('remote_push')).toHaveLength(1);
    expect(fake.callsOf('remote_push')[0]!.args).toMatchObject({ repoId: 1, remote: 'origin', branch: 'main', remoteBranch: 'main', setUpstream: false, forceWithLease: true });
    expect(typeof fake.callsOf('remote_push')[0]!.args.opId).toBe('string');
  });

  it("one commit replaced: singular text", async () => {
    await setup({}, refsWith({ upstream: upstream(1, 1) }));
    void runAction('git.push');
    expect(await screen.findByTestId('confirm-dialog')).toHaveTextContent("1 commit present on the server will be replaced");
  });

  it("before = 0 : push direct, without dialogue, toast \"Push finished\"", async () => {
    const fake = await setup({}, refsWith({ upstream: upstream(2, 0) }));
    await runAction('git.push');
    await whenIdle();
    expect(maybe('confirm-dialog')).toBeNull();
    expect(fake.callsOf('remote_push')[0]!.args).toMatchObject({ forceWithLease: false, setUpstream: false, remote: 'origin', branch: 'main' });
    expect(await screen.findByText("Push finished")).toBeInTheDocument();
  });

  it("already published (ahead = behind = 0): toast \"Already up to date\"", async () => {
    await setup({}, refsWith({ upstream: upstream(0, 0) }));
    await runAction('git.push');
    expect(await screen.findByText("Already up to date")).toBeInTheDocument();
  });

  it("before > 0 and ahead = 0: no push, toast \"make a Pull\"", async () => {
    const fake = await setup({}, refsWith({ upstream: upstream(0, 3) }));
    await runAction('git.push');
    expect(await screen.findByText("origin/main is ahead: pull first")).toBeInTheDocument();
    expect(fake.callsOf('remote_push')).toHaveLength(0);
  });

  it("HEAD detached (one branch menu): toast DETACHED_HEAD of 10 with branch-create-here-btn, none push", async () => {
    const fake = await setup();
    const { actionContext } = await import('$lib/actions/registry');
    const { pushBranch } = await import('./sync');
    // unknown branch of snapshot and HEAD detached: `decidePush` refuses (no branch to push)
    const ctx = { ...actionContext(), repo: { ...repo, head: { branch: null, oid: 'a'.repeat(40), detached: true, unborn: false } } } as never;
    await pushBranch(ctx);
    expect(fake.callsOf('remote_push')).toHaveLength(0);
    const toast = await screen.findByTestId('toast');
    expect(toast).toHaveTextContent("Detached HEAD: Create a branch to push these commits.");
    expect(within(toast).getByTestId('branch-create-here-btn')).toBeInTheDocument();
  });

  it("no remote : remote-add-dialog", async () => {
    const fake = await setup({ remote_list: () => [] }, refsWith({ upstream: null }));
    void runAction('git.push');
    expect(await screen.findByTestId('remote-add-dialog')).toBeInTheDocument();
    expect(fake.callsOf('remote_push')).toHaveLength(0);
  });

  it("not d的upstream: push-dialog pre-filled; validate firm then pushes with setUpstream", async () => {
    const fake = await setup({}, refsWith({ upstream: null }));
    void runAction('git.push');
    expect(await screen.findByTestId('push-dialog')).toBeInTheDocument();
    expect((tid('push-remote-select') as HTMLSelectElement).value).toBe('origin');
    expect((tid('push-remote-branch-input') as HTMLInputElement).value).toBe('main');
    expect(tid('push-set-upstream-toggle')).toBeChecked();
    await userEvent.clear(tid('push-remote-branch-input'));
    await userEvent.type(tid('push-remote-branch-input'), 'feature-x');
    await userEvent.click(tid('push-submit-btn'));
    await whenIdle();
    expect(maybe('push-dialog')).toBeNull();
    expect(fake.callsOf('remote_push')[0]!.args).toMatchObject({ remote: 'origin', branch: 'main', remoteBranch: 'feature-x', setUpstream: true, forceWithLease: false });
  });

  it("push-dialog: empty remote name refused under field", async () => {
    const fake = await setup({}, refsWith({ upstream: null }));
    void runAction('git.push');
    await screen.findByTestId('push-dialog');
    await userEvent.clear(tid('push-remote-branch-input'));
    await userEvent.click(tid('push-submit-btn'));
    expect(screen.getByRole('alert')).toHaveTextContent("Enter the name of the remote branch.");
    expect(fake.callsOf('remote_push')).toHaveLength(0);
    await userEvent.click(tid('push-cancel-btn'));
    expect(maybe('push-dialog')).toBeNull();
  });

  it("menu of a branch: push follow the same table (branch without upstream → push-dialog)", async () => {
    await setup();
    const topic = refs.snapshot?.local.find((b) => b.name === 'fix/typo') as BranchInfo;
    const item = resolveMenu({ menu: 'branch', branch: topic }).find((i) => i.id === 'push')!;
    void item.run();
    expect(await screen.findByTestId('push-dialog')).toBeInTheDocument();
    expect((tid('push-remote-branch-input') as HTMLInputElement).value).toBe('fix/typo');
  });
});

describe("push rejected (10 § Push, releases)", () => {
  it("stale=false : push-rejected-dialog[data-stale=false] → Pull without mode, without pushing", async () => {
    const fake = await setup({}, refsWith({ upstream: upstream(2, 0) }));
    fake.reject('remote_push', err('REJECTED_NON_FF', { operation: 'push', remote: 'origin', branch: 'main', stale: false }, "refused"));
    await runAction('git.push');
    const dlg = await screen.findByTestId('push-rejected-dialog');
    expect(dlg).toHaveAttribute('data-stale', 'false');
    expect(dlg).toHaveTextContent("Push refused: origin/main contains commits that you don't have.");
    expect(maybe('push-rejected-fetch-btn')).toBeNull();
    await userEvent.click(tid('push-rejected-pull-btn'));
    await whenIdle();
    expect(fake.callsOf('remote_pull')).toHaveLength(1);
    expect(fake.callsOf('remote_pull')[0]!.args).not.toHaveProperty('mode');
    expect(fake.callsOf('remote_push')).toHaveLength(1);
  });

  it("stale=true: Fetch of the affected remote (nothing is crushed)", async () => {
    const fake = await setup();
    fake.reject('remote_push', err('REJECTED_NON_FF', { operation: 'push', remote: 'origin', branch: 'main', stale: true }, "expired"));
    void runAction('git.push');
    await userEvent.click(await screen.findByTestId('confirm-dialog-confirm-btn'));
    const dlg = await screen.findByTestId('push-rejected-dialog');
    expect(dlg).toHaveAttribute('data-stale', 'true');
    expect(dlg).toHaveTextContent("The remote branch has changed since your last fetch");
    expect(maybe('push-rejected-pull-btn')).toBeNull();
    await userEvent.click(tid('push-rejected-fetch-btn'));
    await whenIdle();
    expect(fake.callsOf('remote_fetch')).toHaveLength(1);
    expect(fake.callsOf('remote_fetch')[0]!.args).toMatchObject({ remote: 'origin', prune: true });
  });

  it("push-rejected-cancel-btn closes the dialogue without starting anything", async () => {
    const fake = await setup({}, refsWith({ upstream: upstream(2, 0) }));
    fake.reject('remote_push', err('REJECTED_NON_FF', { operation: 'push', stale: false }));
    await runAction('git.push');
    await userEvent.click(await screen.findByTestId('push-rejected-cancel-btn'));
    expect(maybe('push-rejected-dialog')).toBeNull();
    expect(fake.callsOf('remote_pull')).toHaveLength(0);
  });
});

describe('pull (10 §Pull)', () => {
  it("without mode: remote_pull without `mode`; explicit mode for ff-only and rebase", async () => {
    const fake = await setup();
    await runAction('git.pull');
    await runAction('git.pullFfOnly');
    await runAction('git.pullRebase');
    await whenIdle();
    const args = fake.callsOf('remote_pull').map((c) => c.args);
    expect(args).toHaveLength(3);
    expect(args[0]).not.toHaveProperty('mode');
    expect(args[1]).toMatchObject({ mode: 'ff-only' });
    expect(args[2]).toMatchObject({ mode: 'rebase' });
  });

  it("HEAD unchanged: toast \"Already up to date\"", async () => {
    await setup({ remote_pull: () => ({ head: { branch: 'main', oid: repo.head!.oid, detached: false, unborn: false } }) });
    await runAction('git.pull');
    expect(await screen.findByText("Already up to date")).toBeInTheDocument();
  });

  it("divergence (ff-only): pull-diverged-dialog with ↑▼ meters, then pull in rebase mode", async () => {
    const fake = await setup({}, refsWith({ upstream: upstream(1, 2) }));
    fake.reject('remote_pull', err('REJECTED_NON_FF', { operation: 'pull', remote: 'origin', branch: 'main', stale: false, diverged: true }, "Diverged"));
    await runAction('git.pull');
    const dlg = await screen.findByTestId('pull-diverged-dialog');
    expect(dlg).toHaveTextContent("main and origin/main have diverged (↑1 ↓2). Rebase your 1 commit(s) onto origin/main?");
    await userEvent.click(tid('pull-diverged-rebase-btn'));
    await whenIdle();
    expect(fake.callsOf('remote_pull')).toHaveLength(2);
    expect(fake.callsOf('remote_pull')[1]!.args).toMatchObject({ mode: 'rebase' });
    expect(maybe('pull-diverged-dialog')).toBeNull();
  });

  it("pull-dialog-cancel-btn closes without restarting", async () => {
    const fake = await setup();
    fake.reject('remote_pull', err('REJECTED_NON_FF', { operation: 'pull', diverged: true }));
    await runAction('git.pull');
    await screen.findByTestId('pull-diverged-dialog');
    await userEvent.click(tid('pull-dialog-cancel-btn'));
    expect(maybe('pull-diverged-dialog')).toBeNull();
    expect(fake.callsOf('remote_pull')).toHaveLength(1);
  });

  it("worktree dirty in rebase mode: pull-autostash-dialog, restart with the same mode and autostash", async () => {
    const fake = await setup();
    fake.reject('remote_pull', err('DIRTY_WORKTREE', { paths: ['a.txt', 'b.txt'] }, "31 modified files prevent sweater."));
    await runAction('git.pullRebase');
    const dlg = await screen.findByTestId('pull-autostash-dialog');
    expect(dlg).toHaveTextContent("31 modified files prevent pull. Retry with autostash?");
    expect(dlg).toHaveTextContent('a.txt');
    await userEvent.click(tid('pull-autostash-btn'));
    await whenIdle();
    expect(fake.callsOf('remote_pull')[1]!.args).toMatchObject({ mode: 'rebase', autostash: true });
  });

  it("autostash stored in stash: toast \"Your changes have been stored in stash@{0}\"", async () => {
    let stashed = false;
    const entry = { index: 0, oid: 'c'.repeat(40), message: 'autostash', branch: null, baseOid: 'a'.repeat(40), hasIndex: false, hasUntracked: false, time: 1 };
    const fake = await setup({ stash_list: () => (stashed ? [entry] : []), remote_pull: () => ((stashed = true), { head: { branch: 'main', oid: 'b'.repeat(40), detached: false, unborn: false } }) });
    fake.reject('remote_pull', err('DIRTY_WORKTREE', { paths: ['a.txt'] }, "1 modified file prevents sweater."));
    await runAction('git.pullRebase');
    await userEvent.click(await screen.findByTestId('pull-autostash-btn'));
    await whenIdle();
    expect(await screen.findByText("Your changes have been saved in stash@{0}")).toBeInTheDocument();
  });

  it("fast-forward refused by git (stderr): toast \"Commit or stash these files\", without autostash", async () => {
    const fake = await setup();
    fake.reject('remote_pull', err('DIRTY_WORKTREE', { paths: ['a.txt'], stderr: 'error: Your local changes would be overwritten by merge' }));
    await runAction('git.pullFfOnly');
    expect(await screen.findByText(/These files would be overwritten: a\.txt\. Commit or stash these files\./)).toBeInTheDocument();
    expect(maybe('pull-autostash-dialog')).toBeNull();
  });

  it("pull deactivated in HEAD detached and while writing", async () => {
    await setup();
    const { actionContext, getAction, actionDisabledReason } = await import('$lib/actions/registry');
    const end = op.begin('Commit');
    expect(actionDisabledReason(getAction('git.pull')!, actionContext())).toBe("Operation in progress: Commit");
    end();
    expect(actionDisabledReason(getAction('git.pull')!, actionContext())).toBeNull();
  });
});

describe("authentication required (10 §Cas d'error)", () => {
  it("AUTH_REQUIRED on a remote GitHub : dialog + github-login-btn ; successful connection → command restarted", async () => {
    const fake = await setup({
      github_login_start: () => ({ loginId: 'l1', userCode: 'ABCD-1234', verificationUri: 'http://x/device', expiresIn: 900, interval: 1 }),
      github_login_poll: () => ({ status: 'success', interval: 1, login: 'octo-test' }),
      open_external: () => null,
      github_status: () => ({ loggedIn: false, login: null }),
    });
    fake.reject('remote_fetch', err('AUTH_REQUIRED', { remote: 'origin', url: 'https://github.com/demo/gitmini-demo.git' }, "Connection to GitHub required to access demo/gitmini-demo."));
    await runAction('git.fetch');
    const dlg = await screen.findByTestId('auth-required-dialog');
    expect(dlg).toHaveTextContent("Connection to GitHub required to access demo/gitmini-demo.");
    await userEvent.click(tid('github-login-btn'));
    // The false backend allows for the first poll: badge, closing after 1 s, then restarting the order that had failed.
    expect(await screen.findByTestId('github-account-badge')).toHaveTextContent('octo-test');
    await waitFor(() => expect(fake.callsOf('remote_fetch')).toHaveLength(2), { timeout: 3000 });
    expect(maybe('auth-required-dialog')).toBeNull();
  });

  it("other host: credential helper message, no github-login-btn; closing", async () => {
    const fake = await setup({ remote_list: () => [{ name: 'origin', fetchUrl: 'https://git.example.org/o/r.git', pushUrl: 'https://git.example.org/o/r.git', isGithub: false, githubSlug: null }] });
    fake.reject(
      'remote_fetch',
      err('AUTH_REQUIRED', { remote: 'origin', reason: 'credentials', host: 'git.example.org' }, "Authentication rejected by git.example.org. Configure a Git credential helper (e.g. Git Credential Manager)."),
    );
    await runAction('git.fetch');
    const dlg = await screen.findByTestId('auth-required-dialog');
    expect(dlg).toHaveTextContent("Authentication rejected by git.example.org. Configure a Git credential helper");
    expect(maybe('github-login-btn')).toBeNull();
    await userEvent.click(tid('auth-required-close-btn'));
    expect(maybe('auth-required-dialog')).toBeNull();
  });
});

describe("deductions: addition and deletion (10 §Remote management)", () => {
  const NEW_REMOTE: RemoteInfo = { name: 'upstream', fetchUrl: '/tmp/bare.git', pushUrl: '/tmp/bare.git', isGithub: false, githubSlug: null };

  it("tab URL: default name empty if original exists; remote_add then fetch of the new remote", async () => {
    const fake = await setup({ remote_add: () => NEW_REMOTE });
    void openDialog('remote-add-dialog', {});
    await screen.findByTestId('remote-add-dialog');
    expect((tid('remote-add-name-input') as HTMLInputElement).value).toBe('');
    expect(tid('remote-add-fetch-checkbox')).toBeChecked();
    await userEvent.type(tid('remote-add-name-input'), 'upstream');
    await userEvent.type(tid('remote-add-url-input'), '/tmp/bare.git');
    await userEvent.click(tid('remote-add-submit-btn'));
    await whenIdle();
    expect(fake.callsOf('remote_add')[0]!.args).toEqual({ repoId: 1, name: 'upstream', url: '/tmp/bare.git' });
    expect(fake.callsOf('remote_fetch')[0]!.args).toMatchObject({ remote: 'upstream', prune: true });
    expect(maybe('remote-add-dialog')).toBeNull();
  });

  it("errors under the field: invalid name (front), empty URL, backend ALREADY_EXISTS", async () => {
    const fake = await setup();
    void openDialog('remote-add-dialog', {});
    await screen.findByTestId('remote-add-dialog');
    await userEvent.type(tid('remote-add-name-input'), 'a/b');
    await userEvent.click(tid('remote-add-submit-btn'));
    expect(tid('remote-add-error')).toHaveTextContent("A remote name cannot contain \"/\".");
    await userEvent.clear(tid('remote-add-name-input'));
    await userEvent.type(tid('remote-add-name-input'), 'origin');
    await userEvent.click(tid('remote-add-submit-btn'));
    expect(tid('remote-add-error')).toHaveTextContent("Enter the URL of the remote.");
    await userEvent.type(tid('remote-add-url-input'), '/tmp/x.git');
    fake.reject('remote_add', err('ALREADY_EXISTS', { what: 'remote', name: 'origin' }));
    await userEvent.click(tid('remote-add-submit-btn'));
    await whenIdle();
    expect(tid('remote-add-error')).toHaveTextContent("The origin remote already exists.");
    expect(tid('remote-add-dialog')).toBeInTheDocument();
    expect(maybe('toast')).toBeNull();
  });

  it("deletion: confirm-dialog[data-action=remote-remove] with impact, then remote_remove", async () => {
    const fake = await setup({ remote_remove: () => null });
    const remote = refs.remotes[0]!;
    const item = resolveMenu({ menu: 'remote', remote }).find((i) => i.id === 'delete')!;
    expect(item.danger).toBe(true);
    void item.run();
    const dlg = await screen.findByTestId('confirm-dialog');
    expect(dlg).toHaveAttribute('data-action', 'remote-remove');
    expect(dlg).toHaveTextContent("Remove the origin remote and its 2 tracking branches?");
    await userEvent.click(tid('confirm-dialog-confirm-btn'));
    await whenIdle();
    expect(fake.callsOf('remote_remove')[0]!.args).toEqual({ repoId: 1, name: 'origin' });
  });

  it("deleted: none remote_remove", async () => {
    const fake = await setup();
    const item = resolveMenu({ menu: 'remote', remote: refs.remotes[0]! }).find((i) => i.id === 'delete')!;
    void item.run();
    await userEvent.click(await screen.findByTestId('confirm-dialog-cancel-btn'));
    await whenIdle();
    expect(fake.callsOf('remote_remove')).toHaveLength(0);
  });
});

describe('clone (10 §Clone)', () => {
  it("tab URL: next destination \"Browse...\", repo_clone, then opening the repository cloned", async () => {
    const info = makeRepoInfo({ id: 7, name: 'alpha', workdir: '/tmp/dev/alpha' });
    const fake = await setup({ repo_clone: () => info, repo_close: () => null, repo_recent_list: () => [] });
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('/tmp/dev');
    void runAction('repo.clone');
    await screen.findByTestId('clone-dialog');
    expect((tid('clone-dest-input') as HTMLInputElement).value).toBe('');
    await userEvent.type(tid('clone-url-input'), 'https://github.com/octo-test/alpha.git');
    await userEvent.click(tid('clone-dest-browse-btn'));
    expect((tid('clone-dest-input') as HTMLInputElement).value).toBe('/tmp/dev/alpha');
    expect(prompt).toHaveBeenCalled();
    await userEvent.click(tid('clone-submit-btn'));
    await waitFor(() => expect(repo.id).toBe(7));
    expect(fake.callsOf('repo_clone')[0]!.args).toMatchObject({ url: 'https://github.com/octo-test/alpha.git', dest: '/tmp/dev/alpha' });
    expect(typeof fake.callsOf('repo_clone')[0]!.args.opId).toBe('string');
    expect(fake.callsOf('repo_close')).toHaveLength(0);
    expect(repo.tabs).toHaveLength(2);
  });

  it("errors: empty URL, empty destination, unempty destination (ALREADY_EXISTS under the field)", async () => {
    const fake = await setup();
    void runAction('repo.clone');
    await screen.findByTestId('clone-dialog');
    await userEvent.click(tid('clone-submit-btn'));
    expect(tid('clone-error')).toHaveTextContent("Enter the URL of the repository.");
    await userEvent.type(tid('clone-url-input'), '/tmp/bare.git');
    await userEvent.click(tid('clone-submit-btn'));
    expect(tid('clone-dest-error')).toHaveTextContent("Choose the destination folder.");
    await userEvent.type(tid('clone-dest-input'), '/tmp/full');
    fake.reject('repo_clone', err('ALREADY_EXISTS', { what: 'dest', path: '/tmp/full' }));
    await userEvent.click(tid('clone-submit-btn'));
    await whenIdle();
    expect(tid('clone-dest-error')).toHaveTextContent("The /tmp/full folder is not empty.");
    expect(tid('clone-dialog')).toBeInTheDocument();
  });

  it("a clone canceled (CANCELLED) leaves the dialog open with a toast information", async () => {
    const fake = await setup();
    void runAction('repo.clone');
    await screen.findByTestId('clone-dialog');
    await userEvent.type(tid('clone-url-input'), '/tmp/bare.git');
    await userEvent.type(tid('clone-dest-input'), '/tmp/dest');
    fake.reject('repo_clone', err('CANCELLED', { opId: 'x' }));
    await userEvent.click(tid('clone-submit-btn'));
    await whenIdle();
    expect(screen.getByText("Operation canceled.")).toBeInTheDocument();
    expect(tid('clone-dialog')).toBeInTheDocument();
    expect(tid('clone-submit-btn')).toBeEnabled();
  });
});

describe("Open PR (10 § Open PR)", () => {
  it("open-pr input: visible for a branch with the upstream on a GitHub remote, calls github_open_pr", async () => {
    const fake = await setup({ github_open_pr: () => ({ url: 'https://github.com/demo/gitmini-demo/compare/main?expand=1' }) });
    const main = refs.snapshot!.local.find((b) => b.name === 'main')!;
    const item = resolveMenu({ menu: 'branch', branch: main }).find((i) => i.id === 'open-pr');
    expect(item).toBeDefined();
    await item!.run();
    expect(fake.callsOf('github_open_pr')[0]!.args).toEqual({ repoId: 1, branch: 'main' });
  });

  it("masked without remote GitHub", async () => {
    await setup({ remote_list: () => [{ name: 'origin', fetchUrl: '/tmp/x.git', pushUrl: '/tmp/x.git', isGithub: false, githubSlug: null }] });
    const main = refs.snapshot!.local.find((b) => b.name === 'main')!;
    expect(resolveMenu({ menu: 'branch', branch: main }).some((i) => i.id === 'open-pr')).toBe(false);
    const rb = refs.snapshot!.remote[0]!;
    expect(resolveMenu({ menu: 'remote-branch', branch: rb }).some((i) => i.id === 'open-pr')).toBe(false);
  });

  it("unpublished branch: NOT_FOUND remote-branch → toast with backend message", async () => {
    const fake = await setup();
    const main = refs.snapshot!.local.find((b) => b.name === 'main')!;
    fake.on('github_open_pr', () => {
      throw err('NOT_FOUND', { what: 'remote-branch' }, "The main branch is not published on origin. Push it first.");
    });
    await resolveMenu({ menu: 'branch', branch: main }).find((i) => i.id === 'open-pr')!.run();
    expect(await screen.findByText("The main branch is not published on origin. Push it first.")).toBeInTheDocument();
  });
});
