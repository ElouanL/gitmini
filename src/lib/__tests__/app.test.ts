// Whole application smoke (jsdom): start, welcome, open a repository, 3 panel interface.
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../App.svelte';
import { bootstrap } from '../bootstrap';
import { updates } from '../updates/global.svelte';
import { whenIdle } from '../activity';
import { getAction } from '../actions/registry';
import EmptyPanel from '../components/layout/EmptyPanel.svelte';
import { registerRightPanel, resetPanels } from '../panels/registry';
import { unwireEvents } from '../stores/wiring';
import { repo } from '../stores/repo.svelte';
import { createFakeTransport, type FakeTransport } from '../test/fake-transport';
import { makeAppInfo, makeConflictState, makeLogPage, makeRecents, makeRefs, makeRemotes, makeRepoInfo, makeStashes, makeStatus, makeUndo } from '../test/fixtures';
import { resetAll } from '../test/reset';
import '../register-core';
import '../register-domains';

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
    ...over,
  }).install();
}

const tid = (id: string) => screen.getByTestId(id);

beforeEach(() => {
  resetAll({ keepRegistrations: true });
});
afterEach(() => unwireEvents());

describe('accueil', () => {
  it("does not launch updates if the saved user choice cannot be read", async () => {
    fake = backend();
    fake.reject('settings_get', { code: 'GIT_FAILED', message: 'Settings unavailable', details: null });
    const start = vi.spyOn(updates, 'start');
    render(App);
    await bootstrap();
    expect(start).not.toHaveBeenCalled();
    expect(await screen.findByTestId('toolbar-current-branch')).toBeInTheDocument();
  });

  it("displays the buttons, the list of recent ones and opens a repository at click", async () => {
    fake = backend({ settings_get: () => ({ 'workspace.tabs': { paths: [], activePath: null } }) });
    render(App);
    await bootstrap();
    expect(await screen.findByTestId('welcome-open-btn')).toBeInTheDocument();
    expect(tid('welcome-clone-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('welcome-github-login-btn')).toBeNull();
    const items = screen.getAllByTestId('welcome-recent-item');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveAttribute('data-path', '/Users/demo/dev/gitmini-demo');

    await userEvent.click(items[0]!);
    expect(await screen.findByTestId('toolbar-current-branch')).toHaveTextContent('main');
    await whenIdle();
    expect(screen.getAllByTestId('sidebar-branch-item')).toHaveLength(4);
  });

  it("git too old: blocking screen, no repository command called (IU-07)", async () => {
    fake = backend({ app_info: () => makeAppInfo({ gitError: 'GIT_TOO_OLD', git: { path: '/usr/bin/git', version: '2.25.1' } }) });
    render(App);
    await bootstrap();
    const el = await screen.findByTestId('welcome-git-error');
    expect(el).toHaveAttribute('data-code', 'GIT_TOO_OLD');
    expect(el).toHaveTextContent("git 2.25.1 detected, gitmini requires git ≥ 2.30");
    expect(fake.calls.map((c) => c.command)).toEqual(['app_info']);
  });

  it("git not found", async () => {
    fake = backend({ app_info: () => makeAppInfo({ gitError: 'GIT_MISSING', git: null }) });
    render(App);
    await bootstrap();
    expect(await screen.findByTestId('welcome-git-error')).toHaveAttribute('data-code', 'GIT_MISSING');
  });

  it("repository Bare: welcome-open-error[data-code=NOT_A_REPO] (IU-08)", async () => {
    fake = backend({ settings_get: () => ({ 'workspace.tabs': { paths: [], activePath: null } }) });
    fake.reject('repo_open', { code: 'NOT_A_REPO', message: 'bare', details: { path: '/x', reason: 'bare' } });
    render(App);
    await bootstrap();
    await userEvent.click((await screen.findAllByTestId('welcome-recent-item'))[0]!);
    const err = await screen.findByTestId('welcome-open-error');
    expect(err).toHaveAttribute('data-code', 'NOT_A_REPO');
    expect(err).toHaveAttribute('data-reason', 'bare');
  });

  it("gitmini <path> : AppInfo.initialPath opens the repository without going through the host", async () => {
    fake = backend({ app_info: () => makeAppInfo({ initialPath: '/Users/demo/dev/gitmini-demo' }) });
    render(App);
    await bootstrap();
    expect(await screen.findByTestId('toolbar-repo-name')).toBeInTheDocument();
    expect(screen.queryByTestId('welcome-open-btn')).toBeNull();
  });
});

describe("Pallet actions (03) : base + areas", () => {
  it("the 16 pallet identifiers are recorded once all domains are loaded", () => {
    for (const id of [
      'repo.open', 'repo.clone', 'git.fetch', 'git.pull', 'git.pullFfOnly', 'git.pullRebase', 'git.push', 'branch.create', 'stash.save', 'stash.pop',
      'undo.last', 'view.reflog', 'github.login', 'github.logout', 'settings.open', 'theme.toggle',
    ]) {
      expect(getAction(id), id).toBeDefined();
    }
  });
});

describe("3-panel interface", () => {
  async function openShell(over: Record<string, () => unknown> = {}) {
    fake = backend({ app_info: () => makeAppInfo({ initialPath: '/r' }), ...over });
    render(App);
    await bootstrap();
    await screen.findByTestId('toolbar-repo-name');
    await whenIdle();
  }

  it("toolbar: all 03 data-testid, current branch, ahead/behind", async () => {
    await openShell();
    for (const id of [
      'toolbar-repo-name', 'toolbar-current-branch', 'toolbar-undo-btn', 'reflog-panel-btn', 'toolbar-fetch-btn', 'toolbar-pull-btn',
      'toolbar-pull-menu-btn', 'toolbar-push-btn', 'toolbar-ahead-behind', 'toolbar-branch-btn', 'toolbar-stash-btn', 'toolbar-pop-btn',
      'toolbar-search-btn', 'toolbar-palette-btn', 'toolbar-settings-btn',
    ]) expect(tid(id), id).toBeInTheDocument();
    expect(screen.queryByTestId('toolbar-github-btn')).toBeNull();
    expect(tid('toolbar-current-branch')).toHaveTextContent('main');
    const ab = tid('toolbar-ahead-behind');
    expect(ab).toHaveAttribute('data-ahead', '1');
    expect(ab).toHaveAttribute('data-behind', '2');
    expect(tid('toolbar-undo-btn')).toBeEnabled();
    expect(tid('toolbar-pop-btn')).toBeEnabled();
    expect(screen.queryByTestId('toolbar-op-cancel-btn')).toBeNull();
    expect(screen.queryByTestId('toolbar-op-progress')).toBeNull();
  });

  it("HEAD detached: \"HEAD detached @ <sha7>\", pull / push deactivated with 03-pack", async () => {
    await openShell({
      refs_list: () => ({ ...makeRefs(), head: { kind: 'detached', oid: 'abcdef0123456789abcdef0123456789abcdef01' }, local: makeRefs().local.map((b) => ({ ...b, isHead: false })) }),
      status_get: () => makeStatus({ head: { branch: null, oid: 'abcdef0123456789abcdef0123456789abcdef01', detached: true, unborn: false } }),
    });
    expect(tid('toolbar-current-branch')).toHaveTextContent("Detached HEAD @ abcdef0");
    expect(tid('toolbar-pull-btn')).toBeDisabled();
    expect(tid('toolbar-pull-btn')).toHaveAttribute('title', "Detached HEAD: no branch to synchronize");
    expect(tid('toolbar-push-btn')).toBeDisabled();
    expect(tid('branch-create-here-btn')).toBeInTheDocument();
  });

  it('sidebar : sections, compteurs, attributs data-ref / data-current / data-oid', async () => {
    await openShell();
    for (const id of ['sidebar-local-section', 'sidebar-remote-section', 'sidebar-tags-section', 'sidebar-stash-section', 'sidebar-branch-create-btn', 'sidebar-remote-add-btn', 'sidebar-stash-save-btn']) expect(tid(id)).toBeInTheDocument();
    const main = screen.getAllByTestId('sidebar-branch-item').find((e) => e.getAttribute('data-ref') === 'refs/heads/main')!;
    expect(main).toHaveAttribute('data-current', 'true');
    expect(main).toHaveTextContent('↑1 ↓2');
    const topic = screen.getAllByTestId('sidebar-branch-item').find((e) => e.getAttribute('data-ref') === 'refs/heads/topic')!;
    expect(topic).toHaveAttribute('data-current', 'false');
    expect(topic).toHaveTextContent("missing");
    expect(screen.getByTestId('sidebar-remote-item')).toHaveAttribute('data-remote', 'origin');
    // the order is that of the backend (the front does not re-trie): origin/main first in the fixture
    expect(screen.getAllByTestId('sidebar-remote-branch-item').map((e) => e.getAttribute('data-ref'))).toEqual(['refs/remotes/origin/main', 'refs/remotes/origin/feature/login']);
    expect(screen.getAllByTestId('sidebar-tag-item')[0]).toHaveAttribute('data-ref', 'refs/tags/v0.1.0');
    const st = screen.getAllByTestId('sidebar-stash-item');
    expect(st[0]).toHaveAttribute('data-index', '0');
    expect(st[0]).toHaveAttribute('data-oid', '0'.repeat(37) + '384');
  });

  it("operating banner (IU-05): attributes, text 07, Continue disabled as long as paths are in conflict", async () => {
    await openShell({ repo_open: () => makeRepoInfo({ opState: makeConflictState() }) });
    const banner = tid('op-banner');
    expect(banner).toHaveAttribute('data-kind', 'rebase');
    expect(banner).toHaveAttribute('data-phase', 'conflict');
    expect(tid('op-banner-progress')).toHaveTextContent("Rebase feature/login onto main — 3/7 — conflict by applying");
    expect(tid('op-banner-progress')).toHaveTextContent("2 files in conflict");
    expect(tid('op-banner-continue-btn')).toBeDisabled();
    expect(tid('op-banner-skip-btn')).toBeEnabled();
    expect(tid('op-banner-abort-btn')).toBeEnabled();
    // During a state-of-the-art operation: the scripts refused by are disabled, fetch remains allowed.
    expect(tid('toolbar-stash-btn')).toBeDisabled();
    expect(tid('toolbar-fetch-btn')).toBeEnabled();
  });

  it("worktree modified at opening: the line WIP is selected (wt-panel), otherwise empty-panel", async () => {
    resetPanels();
    registerRightPanel('empty-panel', EmptyPanel);
    registerRightPanel('wt-panel', EmptyPanel);
    await openShell(); // makeStatus: 3 files modified
    const { graph } = await import('../stores/graph.svelte');
    expect(graph.selection).toEqual({ kind: 'wip' });
  });

  it("git rebase --abort launched out of app: op:state { state: null } hides banner", async () => {
    await openShell({ repo_open: () => makeRepoInfo({ opState: makeConflictState() }) });
    expect(tid('op-banner')).toBeInTheDocument();
    fake.emit('op:state', { repoId: 1, state: null });
    await waitFor(() => expect(screen.queryByTestId('op-banner')).toBeNull());
  });

  it("right panel: routing according to selection, placeholders bearing the right data-testid", async () => {
    // Independent of domain panels: only the reserved spaces of the base are tested here.
    resetPanels();
    registerRightPanel('empty-panel', EmptyPanel);
    await openShell({ status_get: () => makeStatus({ files: [] }) }); // repository clean: nothing is selected at the opening
    const { graph } = await import('../stores/graph.svelte');
    expect(tid('empty-panel')).toBeInTheDocument();
    graph.selectCommit('a'.repeat(40));
    await waitFor(() => expect(screen.getByTestId('commit-details-panel')).toBeInTheDocument());
    graph.toggleCommit('b'.repeat(40));
    await waitFor(() => expect(screen.getByTestId('multi-commit-panel')).toBeInTheDocument());
    graph.selectWip();
    await waitFor(() => expect(screen.getByTestId('wt-panel')).toBeInTheDocument());
    graph.selectStash('c'.repeat(40), 0);
    await waitFor(() => expect(screen.getByTestId('stash-detail-panel')).toBeInTheDocument());
  });

  it("separators: layout-splitter-left / -right, persistence of layout in settings_set (debum)", async () => {
    await openShell();
    expect(tid('layout-splitter-left')).toBeInTheDocument();
    expect(tid('layout-splitter-right')).toBeInTheDocument();
    const { app } = await import('../stores/app.svelte');
    tid('layout-splitter-left').focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(app.layout.left).toBe(256);
    await whenIdle();
    const sets = fake.callsOf('settings_set').filter((c) => c.args.key === 'layout');
    expect(sets.at(-1)!.args.value).toMatchObject({ left: 256, right: 360 });
    await userEvent.dblClick(tid('layout-splitter-left'));
    expect(app.layout.left).toBe(240);
  });

  it("repository could not be found: repo-missing-screen without cascade of toasts, then back to home (ROB-08)", async () => {
    await openShell();
    const missing = { code: 'NOT_FOUND' as const, message: "missing folder", details: { what: 'workdir' } };
    fake.reject('status_get', missing).reject('refs_list', missing).reject('log_page', missing);
    fake.emit('repo:changed', { repoId: 1, kinds: ['refs', 'head', 'index', 'worktree', 'stash'] });
    expect(await screen.findByTestId('repo-missing-screen')).toBeInTheDocument();
    expect(screen.queryAllByTestId('toast')).toHaveLength(0);
    await userEvent.click(tid('repo-missing-screen-close-btn'));
    expect(await screen.findByTestId('welcome-open-btn')).toBeInTheDocument();
    expect(repo.isOpen).toBe(false);
  });
});
