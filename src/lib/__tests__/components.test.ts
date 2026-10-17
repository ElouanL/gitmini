// Components of the base: context menu, palette, dialogues, toasts, settings, toolbar [L], test bridge, perf.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../App.svelte';
import { bootstrap } from '../bootstrap';
import { whenIdle } from '../activity';
import { runAction } from '../actions/registry';
import { confirmAction } from '../dialogs/confirm';
import { hasDialog, openDialog } from '../dialogs/registry';
import { dialogStack } from '../dialogs/stack.svelte';
import { openContextMenu, resetMenus } from '../menus/registry';
import { perfFrames, perfMark, perfMarkAfterPaint, perfMarks, perfResetAll, setPerfSink, type PerfLine } from '../perf';
import { app } from '../stores/app.svelte';
import { graph } from '../stores/graph.svelte';
import { op } from '../stores/op.svelte';
import { toast } from '../stores/toast.svelte';
import { ui } from '../stores/ui.svelte';
import { github } from '../stores/github.svelte';
import { unwireEvents } from '../stores/wiring';
import { createFakeTransport, type FakeTransport } from '../test/fake-transport';
import { makeAppInfo, makeBranch, makeLogPage, makeRecents, makeRefs, makeRemotes, makeRepoInfo, makeStashes, makeStatus, makeUndo } from '../test/fixtures';
import { resetAll } from '../test/reset';
import { exposeToBridge } from '../test-bridge-hooks';
import '../register-core';
import '../register-domains';

let fake: FakeTransport;
const tid = (id: string) => screen.getByTestId(id);

async function openShell(over: Record<string, () => unknown> = {}) {
  fake = createFakeTransport({
    app_info: () => makeAppInfo({ initialPath: '/r' }), settings_get: () => ({}), settings_set: () => null, repo_recent_list: () => makeRecents(),
    repo_open: () => makeRepoInfo(), repo_close: () => null, log_page: () => makeLogPage(), refs_list: () => makeRefs(), remote_list: () => makeRemotes(),
    stash_list: () => makeStashes(), status_get: () => makeStatus(), undo_peek: () => makeUndo(), github_status: () => ({ loggedIn: false, login: null }),
    ...over,
  }).install();
  render(App);
  await bootstrap();
  await screen.findByTestId('toolbar-repo-name');
  await whenIdle();
}

beforeEach(() => resetAll({ keepRegistrations: true }));
afterEach(() => unwireEvents());

describe('menu contextuel', () => {
  it("context-menu[data-menu] + context-menu-item-<action>; right click on a branch; Escape firm", async () => {
    await openShell();
    const item = screen.getAllByTestId('sidebar-branch-item').find((e) => e.dataset.ref === 'refs/heads/feature/login')!;
    await userEvent.pointer({ keys: '[MouseRight]', target: item });
    const menu = await screen.findByTestId('context-menu');
    expect(menu).toHaveAttribute('data-menu', 'branch');
    expect(within(menu).getByTestId('context-menu-item-checkout')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('context-menu')).toBeNull());
    // On the current branch: no checkout, and never removal (IU-02).
    const current = screen.getAllByTestId('sidebar-branch-item').find((e) => e.dataset.current === 'true')!;
    await userEvent.pointer({ keys: '[MouseRight]', target: current });
    const menu2 = await screen.findByTestId('context-menu');
    expect(within(menu2).queryByTestId('context-menu-item-checkout')).toBeNull();
    expect(within(menu2).queryByTestId('context-menu-item-delete')).toBeNull();
    await userEvent.keyboard('{Escape}');
  });

  it("Shift+F10 opens the menu of the focused element; ▼ + Enter executes the input (checkout)", async () => {
    await openShell({ branch_checkout: () => ({ ...makeRefs(), head: { kind: 'branch', name: 'feature/login' } }) });
    const item = screen.getAllByTestId('sidebar-branch-item').find((e) => e.dataset.ref === 'refs/heads/feature/login')!;
    item.focus();
    await userEvent.keyboard('{Shift>}{F10}{/Shift}');
    const menu = await screen.findByTestId('context-menu');
    expect(document.activeElement).toBe(within(menu).getByTestId('context-menu-item-checkout')); // first focused element
    await userEvent.keyboard('{Enter}');
    await whenIdle();
    expect(fake.callsOf('branch_checkout')[0]!.args).toEqual({ repoId: 1, target: { kind: "local", name: 'feature/login' } });
    expect(screen.queryByTestId('context-menu')).toBeNull();
  });

  it("a menu without visible entry does not open", async () => {
    await openShell();
    resetMenus();
    expect(openContextMenu({ menu: 'stash', stash: makeStashes()[0]! }, 10, 10)).toBe(false); // stash entries provided by their domain
    expect(ui.contextMenu).toBeNull();
  });
});

describe('palette', () => {
  it("Mod+K opens ; filter ; Input executes the command and closes (IU-01)", async () => {
    await openShell({ remote_fetch: () => null });
    ui.paletteOpen = true;
    const input = await screen.findByTestId('palette-input');
    await waitFor(() => expect(document.activeElement).toBe(input));
    await userEvent.type(input, 'fetch');
    const items = screen.getAllByTestId('palette-item');
    expect(items.map((i) => i.dataset.commandId)).toEqual(['git.fetch']);
    await userEvent.keyboard('{Enter}');
    expect(screen.queryByTestId('palette')).toBeNull();
    await whenIdle();
    const call = fake.callsOf('remote_fetch')[0]!;
    expect(call.args).toMatchObject({ repoId: 1, remote: null, prune: true });
    expect(call.args.opId).toMatch(/^[0-9a-f-]{36}$/);
    expect(toast.items.at(-1)).toMatchObject({ kind: 'success', message: "Fetch finished" });
  });

  it("↑/▼ move selection; Escape closes", async () => {
    await openShell();
    ui.paletteOpen = true;
    await screen.findByTestId('palette');
    const first = screen.getAllByTestId('palette-item')[0]!;
    expect(first).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getAllByTestId('palette-item')[1]).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('palette')).toBeNull();
  });
});

describe('dialogues', () => {
  it("confirm-dialog : data-action / data-danger, initial focus on Cancel when danger, Enter does not execute action", async () => {
    await openShell();
    const p = confirmAction({ action: 'discard', danger: true, title: "Discard changes", message: "Cancel changes to 3 files?", confirmLabel: "Discard changes" });
    const dlg = await screen.findByTestId('confirm-dialog');
    expect(dlg).toHaveAttribute('data-action', 'discard');
    expect(dlg).toHaveAttribute('data-danger', 'true');
    await waitFor(() => expect(document.activeElement).toBe(tid('confirm-dialog-cancel-btn')));
    await userEvent.keyboard('{Enter}');
    expect(await p).toBe(false);
  });

  it("confirm-dialog non-danger: focus on Confirm, solve true", async () => {
    await openShell();
    const p = confirmAction({ action: 'remote-remove', title: "Remove", message: "Remove the remote?", confirmLabel: "Remove" });
    await screen.findByTestId('confirm-dialog');
    expect(tid('confirm-dialog')).toHaveAttribute('data-danger', 'false');
    await userEvent.click(tid('confirm-dialog-confirm-btn'));
    expect(await p).toBe(true);
  });

  it("Focus trapped: Tab / Shift+Tab cycle, Escape cancels, the rest of the interface is inert, focus returned", async () => {
    await openShell();
    const opener = tid('toolbar-settings-btn');
    opener.focus();
    const p = openDialog('settings-dialog');
    const dlg = await screen.findByTestId('settings-dialog');
    const rootEl = document.querySelector('.root') as HTMLElement & { inert?: boolean };
    expect(rootEl.inert === true || rootEl.hasAttribute('inert')).toBe(true);
    const focusables = [...dlg.querySelectorAll<HTMLElement>('button, select, input')];
    const last = focusables.at(-1)!;
    last.focus();
    await userEvent.tab();
    expect(dlg.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(last);
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(last);
    await userEvent.keyboard('{Escape}');
    await p;
    await waitFor(() => expect(screen.queryByTestId('settings-dialog')).toBeNull());
    expect(rootEl.inert === true || rootEl.hasAttribute('inert')).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("unknown dialogue: toast error, promise resolved to undefined", async () => {
    await openShell();
    expect(await openDialog('inexistant-dialog')).toBeUndefined();
    expect(toast.items.at(-1)!.kind).toBe('error');
  });
});

describe("settings (IU-03)", () => {
  it("theme: data-theme changes without reloading, settings_set after 300 ms", async () => {
    await openShell();
    void runAction('settings.open');
    const select = await screen.findByTestId('settings-theme-select');
    await userEvent.selectOptions(select, 'dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(app.themeVersion).toBeGreaterThan(0);
    await whenIdle();
    expect(fake.callsOf('settings_set')).toContainEqual({ command: 'settings_set', args: { key: 'theme', value: 'dark' } });
  });

  it('pull.mode, graph.dimUnreachable', async () => {
    await openShell();
    void runAction('settings.open');
    await userEvent.selectOptions(await screen.findByTestId('settings-pull-mode-select'), 'rebase');
    await userEvent.click(tid('settings-graph-dim-unreachable-checkbox'));
    await whenIdle();
    const sets = fake.callsOf('settings_set').map((c) => c.args);
    expect(sets).toContainEqual({ key: 'pull.mode', value: 'rebase' });
    expect(sets).toContainEqual({ key: 'graph.dimUnreachable', value: false });
  });

  it("editor.command: without {path} refused locally (never sent); valid → sent; refusal of backend under the field", async () => {
    await openShell();
    void runAction('settings.open');
    const input = await screen.findByTestId('settings-editor-command-input');
    await userEvent.type(input, 'vim');
    expect(await screen.findByTestId('settings-editor-command-error')).toHaveTextContent('{path}');
    await whenIdle();
    expect(fake.callsOf('settings_set').filter((c) => c.args.key === 'editor.command')).toHaveLength(0);

    await userEvent.clear(input);
    await whenIdle();
    fake.reject('settings_set', { code: 'INVALID_ARGUMENT', message: "non-decoupable control", details: { field: 'value' } });
    await fireEvent.input(input, { target: { value: 'code -g {path}:{line}' } });
    await whenIdle();
    expect(screen.getByTestId('settings-editor-command-error')).toHaveTextContent("non-decoupable control");
    expect(toast.items).toHaveLength(0);
    await userEvent.click(tid('settings-close-btn'));
  });
});

describe("github: never read at boot (10 \"Network and credentials\")", () => {
  it("start, open a repository and palette n-call either github_status or github_login_* (neither keyring nor GET /user)", async () => {
    await openShell({ github_status: () => ({ loggedIn: false, login: null }) });
    ui.paletteOpen = true;
    await screen.findByTestId('palette');
    await whenIdle();
    await userEvent.keyboard('{Escape}');
    const githubCalls = fake.calls.map((c) => c.command).filter((c) => c.startsWith('github_'));
    expect(githubCalls).toEqual([]);
  });

  it("flag disabled: hidden GitHub account and actions, never loaded status", async () => {
    await openShell({ github_status: () => ({ loggedIn: false, login: null }) });
    expect(screen.queryByTestId('toolbar-github-btn')).toBeNull();
    expect(hasDialog('github-login-dialog')).toBe(false);
    expect(await runAction('github.login')).toBe(false);
    github.setLoggedIn('octo-test');
    expect(await runAction('github.logout')).toBe(false);
    await github.refresh();
    await github.ensureLoaded();
    ui.paletteOpen = true;
    await screen.findByTestId('palette');
    const ids = screen.getAllByTestId('palette-item').map((item) => item.getAttribute('data-command-id'));
    expect(ids).not.toContain('github.login');
    expect(ids).not.toContain('github.logout');
    await whenIdle();
    expect(fake.calls.filter((c) => c.command.startsWith('github_'))).toEqual([]);
  });

  it("flag disabled: clone and remove addition by URL, even if the GitHub tab is requested", async () => {
    await openShell();
    void openDialog('clone-dialog', { tab: 'github' });
    expect(await screen.findByTestId('clone-url-input')).toBeInTheDocument();
    expect(screen.queryByTestId('clone-tab-github')).toBeNull();
    expect(screen.queryByTestId('github-repo-picker')).toBeNull();
    await userEvent.click(tid('clone-cancel-btn'));
    void openDialog('remote-add-dialog');
    expect(await screen.findByTestId('remote-add-url-input')).toBeInTheDocument();
    expect(screen.queryByTestId('remote-add-tab-github')).toBeNull();
    expect(fake.calls.filter((c) => c.command.startsWith('github_'))).toEqual([]);
  });

  it("flag disabled: GitHub authentication error does not offer a connection", async () => {
    await openShell();
    void openDialog('auth-required-dialog', {
      error: { code: 'AUTH_REQUIRED', message: 'Authentification requise.', details: { github: true } },
    });
    expect(await screen.findByTestId('auth-required-dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('github-login-btn')).toBeNull();
    expect(tid('auth-required-close-btn')).toBeEnabled();
  });
});

describe('toasts', () => {
  it("toast-details-btn unfolds stderr and arguments; toast-close-btn closes it (IU-06)", async () => {
    await openShell();
    toast.error('fatal', { title: "git failed", details: { stderr: 'fatal: bad', args: ['git', 'fetch'] } });
    const t = await screen.findByTestId('toast');
    expect(t).toHaveAttribute('data-kind', 'error');
    await userEvent.click(within(t).getByTestId('toast-details-btn'));
    expect(within(t).getByTestId('toast-details-stderr')).toHaveTextContent('fatal: bad');
    await userEvent.click(within(t).getByTestId('toast-close-btn'));
    expect(screen.queryByTestId('toast')).toBeNull();
  });
});

describe("toolbar: command [L] (RM-06)", () => {
  it("toolbar-op-progress[data-op-id] + toolbar-op-cancel-btn during fetch; op_cancel { opId }; write buttons disabled", async () => {
    let release!: () => void;
    await openShell({ remote_fetch: () => new Promise((r) => (release = () => r(null))), op_cancel: () => null });
    await userEvent.click(tid('toolbar-fetch-btn'));
    const progress = await screen.findByTestId('toolbar-op-progress');
    const opId = progress.dataset.opId!;
    expect(opId).toMatch(/^[0-9a-f-]{36}$/);
    expect(tid('toolbar-fetch-btn')).toBeDisabled();
    expect(tid('toolbar-stash-btn')).toBeDisabled();
    expect(tid('toolbar-fetch-btn')).toHaveAttribute('title', "Operation in progress: Fetch");
    fake.emit('op:progress', { opId, label: 'Receiving objects', percent: 42 });
    await waitFor(() => expect(progress).toHaveTextContent('Receiving objects 42 %'));
    await userEvent.click(tid('toolbar-op-cancel-btn'));
    expect(fake.callsOf('op_cancel')[0]!.args).toEqual({ opId });
    release();
    await whenIdle();
    await waitFor(() => expect(screen.queryByTestId('toolbar-op-progress')).toBeNull());
    expect(op.inflight).toBeNull();
  });

  it("CANCELLED: toast d'information \"Operation canceled\", no toast of success", async () => {
    await openShell({ remote_fetch: () => Promise.reject({ code: 'CANCELLED', message: "cancelled", details: { opId: 'x' } }) });
    await userEvent.click(tid('toolbar-fetch-btn'));
    await whenIdle();
    expect(toast.items.map((t) => [t.kind, t.title])).toEqual([['info', "Operation cancelled"]]);
  });

  it("toolbar-undo-btn : pattern infobullet when cancellation is unavailable", async () => {
    await openShell({ undo_peek: () => ({ entry: null, available: false, reason: 'empty', head: null }) });
    expect(tid('toolbar-undo-btn')).toBeDisabled();
    expect(tid('toolbar-undo-btn')).toHaveAttribute('title', "Nothing to undo.");
  });

  it("toolbar-undo-btn: Infobulle = input wording when cancellation is available (11)", async () => {
    await openShell();
    expect(tid('toolbar-undo-btn')).toBeEnabled();
    expect(tid('toolbar-undo-btn')).toHaveAttribute('title', "Cancel the commit « feel: login form »");
  });

  it('toolbar-pull-menu : fetch / ff-only / rebase', async () => {
    await openShell({ remote_pull: () => ({ head: { branch: 'main', oid: '1'.repeat(40), detached: false, unborn: false } }) });
    await userEvent.click(tid('toolbar-pull-menu-btn'));
    const menu = await screen.findByTestId('toolbar-pull-menu');
    for (const id of ['fetch', 'ff-only', 'rebase']) expect(within(menu).getByTestId(`toolbar-pull-menu-item-${id}`)).toBeInTheDocument();
    await userEvent.click(within(menu).getByTestId('toolbar-pull-menu-item-rebase'));
    await whenIdle();
    expect(fake.callsOf('remote_pull')[0]!.args).toMatchObject({ repoId: 1, mode: 'rebase' });
  });

  it("toolbar-pull-btn: without mode (backend solves mode, 03)", async () => {
    await openShell({ remote_pull: () => ({ head: { branch: 'main', oid: '1'.repeat(40), detached: false, unborn: false } }) });
    await userEvent.click(tid('toolbar-pull-btn'));
    await whenIdle();
    const args = fake.callsOf('remote_pull')[0]!.args;
    expect('mode' in args).toBe(false);
  });

  it("toolbar-stash-btn: stash immediate with includeUntracked, git message; toast if nothing to stasher", async () => {
    await openShell({ stash_save: () => ({ created: null, list: [] }) });
    await userEvent.click(tid('toolbar-stash-btn'));
    await whenIdle();
    expect(fake.callsOf('stash_save')[0]!.args).toEqual({ repoId: 1, includeUntracked: true, keepIndex: false });
    expect(toast.items.at(-1)).toMatchObject({ kind: 'info', message: "No changes to be set aside." });
  });
});

describe('sidebar : interactions', () => {
  it("double-clic → local checkout ; Enter → checkout ; simple click → selection + scrolling of the graph", async () => {
    await openShell({ branch_checkout: () => makeRefs() });
    const feature = screen.getAllByTestId('sidebar-branch-item').find((e) => e.dataset.ref === 'refs/heads/feature/login')!;
    await userEvent.click(feature);
    expect(graph.selection).toMatchObject({ kind: 'commits', anchor: '0'.repeat(38) + '37' });
    await userEvent.dblClick(feature);
    await whenIdle();
    expect(fake.callsOf('branch_checkout').at(-1)!.args).toEqual({ repoId: 1, target: { kind: "local", name: 'feature/login' } });
    feature.focus();
    await userEvent.keyboard('{Enter}');
    await whenIdle();
    expect(fake.callsOf('branch_checkout')).toHaveLength(2);
  });

  it("remote branch : double-clic → checkout { kind: remote, ref }", async () => {
    await openShell({ branch_checkout: () => makeRefs() });
    const rb = screen.getAllByTestId('sidebar-remote-branch-item').find((e) => e.dataset.ref === 'refs/remotes/origin/main')!;
    await userEvent.dblClick(rb);
    await whenIdle();
    expect(fake.callsOf('branch_checkout')[0]!.args).toEqual({ repoId: 1, target: { kind: 'remote', ref: 'origin/main' } });
  });

  it("the current branch is not re-checked; F2 opens the rename dialog (branch domain)", async () => {
    await openShell();
    const main = screen.getAllByTestId('sidebar-branch-item').find((e) => e.dataset.current === 'true')!;
    await userEvent.dblClick(main);
    expect(fake.callsOf('branch_checkout')).toHaveLength(0);
    main.focus();
    await userEvent.keyboard('{F2}');
    await whenIdle(); // on request (separate chink)
    // Dialogue provided by the branches domain; without it, toast "Function unavailable".
    if (hasDialog('branch-rename-dialog')) expect(dialogStack.top?.id).toBe('branch-rename-dialog');
    else expect(toast.items.at(-1)!.message).toContain('branch-rename-dialog');
  });

  it("tag: double-clic and Enter → remote checkout from targetOid; right click: checkout-detached and copy-name (06 \"Interactions\")", async () => {
    await openShell({ branch_checkout: () => makeRefs() });
    const tag = screen.getAllByTestId('sidebar-tag-item').find((e) => e.dataset.ref === 'refs/tags/v0.2.0')!; // annotated : tagOid
    await userEvent.dblClick(tag);
    await whenIdle();
    expect(fake.callsOf('branch_checkout')[0]!.args).toEqual({ repoId: 1, target: { kind: 'detached', oid: makeRefs().tags[1]!.targetOid } });
    tag.focus();
    await userEvent.keyboard('{Enter}');
    await whenIdle();
    expect(fake.callsOf('branch_checkout')).toHaveLength(2);
    expect(fake.callsOf('branch_checkout')[1]!.args).toMatchObject({ target: { kind: 'detached' } });
  });

  it("tag: a simple click selects the commit pointed without checkout", async () => {
    await openShell({ branch_checkout: () => makeRefs() });
    const tag = screen.getAllByTestId('sidebar-tag-item').find((e) => e.dataset.ref === 'refs/tags/v0.1.0')!;
    await userEvent.click(tag);
    expect(graph.selection).toMatchObject({ kind: 'commits', anchor: makeRefs().tags[0]!.targetOid });
    expect(fake.callsOf('branch_checkout')).toHaveLength(0);
  });

  it("sidebar keeps backend order: branches (current first), remotes, tags (decrease version), without re-tri", async () => {
    const refsData = makeRefs();
    const reordered = {
      ...refsData,
      local: [refsData.local[2]!, refsData.local[0]!, refsData.local[3]!, refsData.local[1]!], // fix/typo, main, topic, feature/login
      tags: [{ ...refsData.tags[1]!, name: 'v10.0', fullRef: 'refs/tags/v10.0' }, { ...refsData.tags[0]!, name: 'v2.0', fullRef: 'refs/tags/v2.0' }, { ...refsData.tags[0]!, name: 'v1.0', fullRef: 'refs/tags/v1.0' }],
    };
    await openShell({ refs_list: () => reordered });
    expect(screen.getAllByTestId('sidebar-branch-item').map((e) => e.dataset.ref)).toEqual([
      'refs/heads/fix/typo', 'refs/heads/main', 'refs/heads/topic', 'refs/heads/feature/login',
    ]);
    expect(screen.getAllByTestId('sidebar-tag-item').map((e) => e.dataset.ref)).toEqual(['refs/tags/v10.0', 'refs/tags/v2.0', 'refs/tags/v1.0']);
    expect(tid('sidebar-tags-section')).toBeInTheDocument();
    expect(screen.getAllByTestId('sidebar-tag-item').length).toBe(3); // the Tags section is unfolded by default
  });

  it("arrows ↑/▼ : moving tabindex in sidebar (folders are stops of the list)", async () => {
    await openShell();
    const items = [...document.querySelectorAll<HTMLElement>('[data-zone="sidebar"] [data-roving]')];
    expect(items[1]).toHaveAttribute('data-testid', 'sidebar-folder-item'); // main, then the `feature` folder
    items[0]!.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(items[1]);
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(items[2]); // feature/login, inside the folder
    await userEvent.keyboard('{ArrowUp}{ArrowUp}');
    expect(document.activeElement).toBe(items[0]);
    expect(items.filter((i) => i.getAttribute('tabindex') === '0')).toHaveLength(1);
  });
});

/** Local branches, `current` being the HEAD one; remote, tags and stashes are those of `makeRefs`. */
function refsWith(current: string, names: string[]) {
  return { ...makeRefs(), head: { kind: 'branch' as const, name: current }, local: names.map((n, i) => makeBranch(n, 50 - i, { isHead: n === current })) };
}

const branchRefs = () => screen.queryAllByTestId('sidebar-branch-item').map((e) => e.dataset.ref);
const folderEl = (scope: string, folder: string) => screen.getAllByTestId('sidebar-folder-item').find((e) => e.dataset.scope === scope && e.dataset.folder === folder)!;

describe('sidebar : prefix folders', () => {
  it("branches sharing a prefix sit in a folder labelled by their last segment; click and ←/→ fold it", async () => {
    await openShell();
    const feature = folderEl('local', 'feature');
    expect(feature).toHaveAttribute('aria-expanded', 'true');
    expect(feature).toHaveTextContent('feature');
    expect(feature).toHaveTextContent('(1)');
    const login = () => screen.queryAllByTestId('sidebar-branch-item').find((e) => e.dataset.ref === 'refs/heads/feature/login');
    expect(login()!.querySelector('.name')!.textContent).toBe('login');
    expect(login()).toHaveAttribute('title', 'feature/login');
    // Root-level branches stay at the root, the remote list has its own `main` and no folder for it.
    expect(branchRefs()).toEqual(['refs/heads/main', 'refs/heads/feature/login', 'refs/heads/fix/typo', 'refs/heads/topic']);

    await userEvent.click(folderEl('local', 'feature'));
    expect(folderEl('local', 'feature')).toHaveAttribute('aria-expanded', 'false');
    expect(login()).toBeUndefined();
    folderEl('local', 'feature').focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(login()).toBeDefined();
    await userEvent.keyboard('{ArrowLeft}');
    expect(login()).toBeUndefined();
    await userEvent.keyboard('{Enter}');
    expect(login()).toBeDefined();
  });

  it("the same prefix is a distinct folder in the local, remote and tag lists", async () => {
    const data = { ...makeRefs(), tags: [{ ...makeRefs().tags[0]!, name: 'feature/v1', fullRef: 'refs/tags/feature/v1' }, makeRefs().tags[1]!] };
    await openShell({ refs_list: () => data });
    expect(screen.getAllByTestId('sidebar-folder-item').map((e) => `${e.dataset.scope}:${e.dataset.folder}`)).toEqual([
      'local:feature', 'local:fix', 'remote:origin:feature', 'tags:feature',
    ]);
    await userEvent.click(folderEl('tags', 'feature'));
    expect(screen.queryAllByTestId('sidebar-tag-item').map((e) => e.dataset.ref)).toEqual(['refs/tags/v0.2.0']);
    expect(screen.getAllByTestId('sidebar-remote-branch-item')).toHaveLength(2); // the remote folder is untouched
    expect(branchRefs()).toContain('refs/heads/feature/login');
  });

  it("a collapsed folder holding the current branch shows a marker and takes the Mod+1 focus", async () => {
    await openShell({ refs_list: () => refsWith('feature/login', ['feature/login', 'main']) });
    const { focusZone } = await import('../actions/focus');
    expect(focusZone('sidebar')).toBe(true);
    expect(document.activeElement).toHaveAttribute('data-current', 'true');
    await userEvent.click(folderEl('local', 'feature'));
    const feature = folderEl('local', 'feature');
    expect(feature.querySelector('[role="img"]')).toHaveAttribute('aria-label', 'contains the current branch');
    expect(feature).toHaveAttribute('data-zone-focus');
    expect(focusZone('sidebar')).toBe(true);
    expect(document.activeElement).toBe(feature);
  });

  it("each list is a tree for a screen reader: items with a level and a place among their siblings, folders and remotes with their state", async () => {
    await openShell();
    const place = (el: HTMLElement) => `${el.getAttribute('aria-level')}:${el.getAttribute('aria-posinset')}/${el.getAttribute('aria-setsize')}`;
    const [local, remote, tags] = screen.getAllByRole('tree');
    expect(screen.getAllByRole('tree').map((e) => e.getAttribute('aria-label'))).toEqual(['Local', 'Remote', 'Tags']);
    // main, feature (login), fix (typo), topic: four at the top; the branch of a folder is level 2, alone in it.
    expect(within(local!).getAllByRole('treeitem').map(place)).toEqual(['1:1/4', '1:2/4', '2:1/1', '1:3/4', '2:1/1', '1:4/4']);
    expect(within(local!).getAllByRole('treeitem').map((e) => e.getAttribute('aria-expanded'))).toEqual([null, 'true', null, 'true', null, null]);
    // The branches of a remote hang under it: they start at level 2.
    const origin = within(remote!).getByTestId('sidebar-remote-item');
    expect(origin).toHaveAttribute('role', 'treeitem');
    expect([place(origin), origin.getAttribute('aria-expanded')]).toEqual(['1:1/1', 'true']);
    expect(within(within(remote!).getByRole('group')).getAllByRole('treeitem').map(place)).toEqual(['2:1/2', '2:2/2', '3:1/1']);
    expect(within(tags!).getAllByRole('treeitem')).toHaveLength(2);

    // Folding a folder changes what is listed, and the rest is numbered again.
    await userEvent.click(folderEl('local', 'feature'));
    expect(within(local!).getAllByRole('treeitem').map(place)).toEqual(['1:1/4', '1:2/4', '1:3/4', '2:1/1', '1:4/4']);
    expect(folderEl('local', 'feature')).toHaveAttribute('aria-expanded', 'false');
    // The keyboard model is unchanged: one stop in the tab order, ↓ walks the items.
    const stops = [...document.querySelectorAll<HTMLElement>('[data-zone="sidebar"] [data-roving]')];
    expect(stops.filter((e) => e.dataset.testid !== 'sidebar-stash-item').every((e) => e.getAttribute('role') === 'treeitem')).toBe(true); // stashes are a plain list
    expect(stops.filter((e) => e.getAttribute('tabindex') === '0')).toHaveLength(1);
  });

  it("the toolbar's current branch button reaches the branch: it opens a closed folder or section and clears a filter that hides it", async () => {
    await openShell({ refs_list: () => refsWith('feature/login', ['feature/login', 'main']) });
    const current = () => screen.queryAllByTestId('sidebar-branch-item').find((e) => e.dataset.current === 'true');
    const filter = () => tid('sidebar-filter-input') as HTMLInputElement;
    await userEvent.click(tid('toolbar-current-branch'));
    await waitFor(() => expect(document.activeElement).toBe(current()));

    // Its folder is closed.
    await userEvent.click(folderEl('local', 'feature'));
    expect(current()).toBeUndefined();
    await userEvent.click(tid('toolbar-current-branch'));
    await waitFor(() => expect(document.activeElement).toBe(current()));
    expect(folderEl('local', 'feature')).toHaveAttribute('aria-expanded', 'true');

    // The whole section is closed.
    await userEvent.click(screen.getByRole('button', { name: /^Local/ }));
    expect(current()).toBeUndefined();
    await userEvent.click(tid('toolbar-current-branch'));
    await waitFor(() => expect(document.activeElement).toBe(current()));

    // A filter hides it.
    await userEvent.type(filter(), 'main');
    expect(current()).toBeUndefined();
    await userEvent.click(tid('toolbar-current-branch'));
    await waitFor(() => expect(document.activeElement).toBe(current()));
    expect(filter()).toHaveValue('');

    // A filter that keeps it, with its folder closed since the last keystroke.
    await userEvent.type(filter(), 'login');
    await userEvent.click(folderEl('local', 'feature'));
    expect(current()).toBeUndefined();
    await userEvent.click(tid('toolbar-current-branch'));
    await waitFor(() => expect(document.activeElement).toBe(current()));
    expect(filter()).toHaveValue('login');
  });
});

describe('sidebar : filter', () => {
  const input = () => tid('sidebar-filter-input') as HTMLInputElement;

  it("narrows branches, remote branches, tags and stashes by name, with counts, whatever the case", async () => {
    await openShell();
    await userEvent.type(input(), 'LOGIN');
    expect(branchRefs()).toEqual(['refs/heads/feature/login']);
    expect(screen.getAllByTestId('sidebar-remote-branch-item').map((e) => e.dataset.ref)).toEqual(['refs/remotes/origin/feature/login']);
    expect(screen.queryByTestId('sidebar-tags-section')).toBeNull(); // no tag matches: the section leaves
    expect(screen.getAllByTestId('sidebar-stash-item')).toHaveLength(1); // "On feature/login: experiment"
    expect(tid('sidebar-local-count')).toHaveTextContent('(1/4)');
    expect(tid('sidebar-stash-count')).toHaveTextContent('(1/2)');
    expect(tid('sidebar-filter-status')).toHaveTextContent('3 references match');
    expect(screen.getByTestId('sidebar-remote-item')).toHaveTextContent('(1/2)');
  });

  it("matches every term anywhere in the name, the remote name included", async () => {
    await openShell();
    await userEvent.type(input(), 'typo fix');
    expect(branchRefs()).toEqual(['refs/heads/fix/typo']);
    await userEvent.clear(input());
    await userEvent.type(input(), 'origin/feat');
    expect(branchRefs()).toEqual([]);
    expect(screen.getAllByTestId('sidebar-remote-branch-item').map((e) => e.dataset.ref)).toEqual(['refs/remotes/origin/feature/login']);
    await userEvent.clear(input());
    await userEvent.type(input(), 'v0.2');
    expect(screen.getAllByTestId('sidebar-tag-item').map((e) => e.dataset.ref)).toEqual(['refs/tags/v0.2.0']);
  });

  it("opens the folders and sections that were closed, then gives them back as they were", async () => {
    await openShell();
    await userEvent.click(folderEl('local', 'feature'));
    await userEvent.click(screen.getByRole('button', { name: /^Tags/ })); // the tags section header
    expect(branchRefs()).not.toContain('refs/heads/feature/login');
    expect(screen.queryAllByTestId('sidebar-tag-item')).toHaveLength(0);

    await userEvent.type(input(), 'v0.1 login');
    expect(branchRefs()).toEqual([]); // both terms are needed: nothing has v0.1 and login together
    await userEvent.clear(input());
    await userEvent.type(input(), 'login');
    expect(branchRefs()).toEqual(['refs/heads/feature/login']);
    await userEvent.clear(input());
    await userEvent.type(input(), 'v0');
    expect(screen.getAllByTestId('sidebar-tag-item')).toHaveLength(2);

    // Closing a folder while filtering only lasts until the text changes.
    await userEvent.clear(input());
    await userEvent.type(input(), 'login');
    await userEvent.click(folderEl('local', 'feature'));
    expect(branchRefs()).toEqual([]);
    await userEvent.type(input(), '{Backspace}');
    expect(branchRefs()).toEqual(['refs/heads/feature/login']);

    await userEvent.click(tid('sidebar-filter-clear-btn'));
    expect(input()).toHaveValue('');
    expect(document.activeElement).toBe(input());
    expect(branchRefs()).not.toContain('refs/heads/feature/login'); // the folder is closed again
    expect(folderEl('local', 'feature')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryAllByTestId('sidebar-tag-item')).toHaveLength(0);
    expect(tid('sidebar-local-count')).toHaveTextContent('(4)');
  });

  it("says so when nothing matches and puts everything back when the filter is cleared", async () => {
    await openShell();
    await userEvent.type(input(), 'zzz');
    expect(tid('sidebar-filter-empty')).toHaveTextContent('Nothing matches "zzz"');
    for (const id of ['sidebar-local-section', 'sidebar-remote-section', 'sidebar-tags-section', 'sidebar-stash-section']) expect(screen.queryByTestId(id)).toBeNull();
    await userEvent.keyboard('{Escape}');
    expect(input()).toHaveValue('');
    expect(screen.queryByTestId('sidebar-filter-empty')).toBeNull();
    for (const id of ['sidebar-local-section', 'sidebar-remote-section', 'sidebar-tags-section', 'sidebar-stash-section']) expect(tid(id)).toBeInTheDocument();
    expect(branchRefs()).toHaveLength(4);
  });

  it("a blank filter filters nothing", async () => {
    await openShell();
    await userEvent.type(input(), '   ');
    expect(branchRefs()).toHaveLength(4);
    expect(tid('sidebar-local-count')).toHaveTextContent('(4)');
    expect(screen.queryByTestId('sidebar-filter-empty')).toBeNull();
  });

  it("follows the refs while typed: a branch created meanwhile that matches appears", async () => {
    await openShell();
    await userEvent.type(input(), 'login');
    const { refs } = await import('../stores/refs.svelte');
    refs.apply({ ...makeRefs(), local: [...makeRefs().local, makeBranch('feature/login-v2', 20)] });
    await waitFor(() => expect(branchRefs()).toEqual(['refs/heads/feature/login', 'refs/heads/feature/login-v2']));
    expect(tid('sidebar-local-count')).toHaveTextContent('(2/5)');
  });

  it("is forgotten when the repository is closed", async () => {
    await openShell();
    await userEvent.type(input(), 'login');
    expect(ui.sidebarFilter).toBe('login');
    ui.resetForRepo();
    expect(ui.sidebarFilter).toBe('');
    expect(ui.sidebarFoldersOpen).toEqual({});
  });

  it("keyboard: / reaches the field from the lists, ↓ jumps to the first leaf, Enter then checks it out, Escape clears then leaves", async () => {
    await openShell({ branch_checkout: () => makeRefs() });
    const main = screen.getAllByTestId('sidebar-branch-item').find((e) => e.dataset.current === 'true')!;
    main.focus();
    await userEvent.keyboard('/');
    expect(document.activeElement).toBe(input());
    expect(input()).toHaveValue(''); // the slash opens the field, it is not typed in it
    await userEvent.keyboard('feature/{ArrowDown}');
    expect(input()).toHaveValue('feature/'); // a slash typed in the field stays a character
    expect(document.activeElement).toHaveAttribute('data-ref', 'refs/heads/feature/login'); // not the folder row before it
    await userEvent.keyboard('{Enter}');
    await whenIdle();
    expect(fake.callsOf('branch_checkout').at(-1)!.args).toEqual({ repoId: 1, target: { kind: 'local', name: 'feature/login' } });

    input().focus();
    await userEvent.keyboard('{Escape}');
    expect(input()).toHaveValue('');
    expect(document.activeElement).toBe(input()); // first Escape clears
    await userEvent.keyboard('{Escape}');
    expect(document.activeElement).toHaveAttribute('data-testid', 'sidebar-branch-item'); // second one leaves the field
  });

  it("palette: 'Filter branches and tags' focuses the field, showing a collapsed sidebar first", async () => {
    await openShell();
    ui.paletteOpen = true;
    await userEvent.type(await screen.findByTestId('palette-input'), 'filter bra');
    expect(screen.getAllByTestId('palette-item').map((i) => i.dataset.commandId)).toEqual(['sidebar.filter']);
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(document.activeElement).toBe(input()));

    await userEvent.click(tid('layout-sidebar-toggle-btn'));
    expect(screen.queryByTestId('sidebar-filter-input')).toBeNull();
    expect(await runAction('sidebar.filter')).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(input()));
  });
});

describe('Mod+1 / Mod+2 / Mod+3', () => {
  it("Area focus: current sidebar branch, right panel", async () => {
    await openShell();
    const { focusZone } = await import('../actions/focus');
    expect(focusZone('sidebar')).toBe(true);
    expect(document.activeElement).toHaveAttribute('data-current', 'true');
    expect(focusZone('right')).toBe(true);
    expect(tid('layout-right').contains(document.activeElement)).toBe(true); // inside the area (list of wt-panel, or the area itself)
  });
});

describe("window._gitmini test deck and measurements", () => {
  it('events.count / last, perf.marks / frames / reset, idle(), parties de domaine', async () => {
    fake = createFakeTransport({ undo_peek: () => makeUndo(), status_get: () => makeStatus() }).install();
    const { installBridge } = await import('../test-bridge');
    exposeToBridge('graph', () => ({ rowOf: () => 3 }));
    const bridge = installBridge();
    expect(window.__gitmini).toBe(bridge);
    expect((bridge.graph as { rowOf(): number }).rowOf()).toBe(3);
    const { startEvents } = await import('../ipc/events');
    await startEvents();
    fake.emit('repo:changed', { repoId: 1, kinds: ['refs'] });
    fake.emit('op:state', { repoId: 1, state: null });
    expect(bridge.events.count('repo:changed')).toBeGreaterThanOrEqual(1);
    expect(bridge.events.last('repo:changed')).toEqual({ repoId: 1, kinds: ['refs'] });
    expect(bridge.events.count('op:progress')).toBe(0);
    perfMark('gitmini:app-ready');
    expect(bridge.perf.marks().map((m) => m.name)).toContain('gitmini:app-ready');
    bridge.perf.reset();
    expect(bridge.perf.frames()).toEqual([]);
    await expect(bridge.idle()).resolves.toBeUndefined();
  });

  it("perfMark: performance.mark + buffer + receiver GITMINI_PERF_TRACE (JSON lines, t in ms epoch)", () => {
    perfResetAll();
    const lines: unknown[] = [];
    setPerfSink((l) => lines.push(l));
    perfMark('gitmini:repo-open-start');
    setPerfSink(null);
    expect(perfMarks()).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: 'mark', name: 'gitmini:repo-open-start' });
    const t = (lines[0] as { t: number }).t;
    expect(t).toBeGreaterThan(1_600_000_000_000);
    expect(perfFrames()).toEqual([]);
    vi.restoreAllMocks();
  });

  it("perfMarkAfterPaint: `via: 'paint'` after two frames, `via: 'timeout'` when no frame is painted", async () => {
    const lines: PerfLine[] = [];
    setPerfSink((l) => lines.push(l));
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0));
    await perfMarkAfterPaint('gitmini:app-ready');
    vi.stubGlobal('requestAnimationFrame', () => 0);
    await perfMarkAfterPaint('gitmini:app-ready', { fallbackMs: 5, screen: 'git-error' });
    vi.unstubAllGlobals();
    setPerfSink(null);
    expect(lines).toMatchObject([
      { kind: 'mark', name: 'gitmini:app-ready', via: 'paint' },
      { kind: 'mark', name: 'gitmini:app-ready', via: 'timeout', screen: 'git-error' },
    ]);
  });
});

describe("narrow window, system theme, tips", () => {
  function stubMedia(opts: { narrow?: boolean; dark?: boolean }) {
    const listeners = new Map<string, Set<() => void>>();
    const state = { narrow: !!opts.narrow, dark: !!opts.dark };
    vi.stubGlobal('matchMedia', (q: string) => ({
      get matches() {
        return q.includes('max-width') ? state.narrow : q.includes('prefers-color-scheme: dark') ? state.dark : false;
      },
      media: q,
      addEventListener: (_: string, fn: () => void) => (listeners.get(q) ?? listeners.set(q, new Set()).get(q)!).add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.get(q)?.delete(fn),
    }));
    return { state, fire: (q: string) => listeners.get(q)?.forEach((f) => f()) };
  }
  afterEach(() => vi.unstubAllGlobals());

  it("< 1200 px: the right panel is folded, then opens par-dessus the graph at selection", async () => {
    stubMedia({ narrow: true });
    await openShell({ status_get: () => makeStatus({ files: [] }) }); // repository clean: nothing is selected
    expect(screen.queryByTestId('layout-right')).toBeNull();
    expect(screen.queryByTestId('layout-splitter-right')).toBeNull();
    graph.selectCommit('a'.repeat(40));
    expect(await screen.findByTestId('layout-right')).toBeInTheDocument();
    expect(screen.getByTestId('commit-details-panel')).toBeInTheDocument();
    await userEvent.click(tid('layout-right-close-btn'));
    expect(screen.queryByTestId('layout-right')).toBeNull();
  });

  it("≥ 1200 px: right panel is anchored; layout.rightCollapsed mask", async () => {
    stubMedia({ narrow: false });
    await openShell();
    expect(tid('layout-right')).toBeInTheDocument();
    await userEvent.click(tid('layout-right-toggle-btn'));
    expect(screen.queryByTestId('layout-right')).toBeNull();
    expect(app.layout.rightCollapsed).toBe(true);
    await userEvent.click(tid('layout-sidebar-toggle-btn'));
    expect(screen.queryByTestId('layout-left')).toBeNull();
    await whenIdle();
    expect(fake.callsOf('settings_set').at(-1)!.args.value).toMatchObject({ leftCollapsed: true, rightCollapsed: true });
  });

  it("system theme follows prefers-color-scheme live; system theme unknown = clear", () => {
    const m = stubMedia({ dark: false });
    app.load({ theme: 'system' });
    expect(document.documentElement.dataset.theme).toBe('light');
    m.state.dark = true;
    m.fire('(prefers-color-scheme: dark)');
    expect(document.documentElement.dataset.theme).toBe('dark');
    app.load({ theme: 'light' });
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it("commit-graph tip: > 50,000 commits without commit-graph; layout-hint-dismiss-btn mask until repository closes", async () => {
    await openShell({
      repo_open: () => makeRepoInfo({ hasCommitGraph: false }),
      log_page: () => makeLogPage(60, 60, 0, 120_000),
    });
    const banner = await screen.findByTestId('layout-hint-banner');
    expect(banner).toHaveAttribute('data-hint', 'commit-graph');
    expect(banner).toHaveTextContent('git commit-graph write --reachable');
    await userEvent.click(tid('layout-hint-dismiss-btn'));
    expect(screen.queryByTestId('layout-hint-banner')).toBeNull();
    ui.showHint('watcher-degraded');
    expect(await screen.findByTestId('layout-hint-banner')).toHaveAttribute('data-hint', 'watcher-degraded');
  });

  it("watcher degraded: layout-hint-banner[data-hint=watcher-degraded], maskable, disappears when normal", async () => {
    await openShell({ status_get: () => makeStatus({ watcherDegraded: true }) });
    const banner = await screen.findByTestId('layout-hint-banner');
    expect(banner).toHaveAttribute('data-hint', 'watcher-degraded');
    fake.on('status_get', () => makeStatus({ watcherDegraded: false }));
    fake.emit('repo:changed', { repoId: 1, kinds: ['refs', 'index', 'worktree', 'head', 'stash'] });
    await waitFor(() => expect(screen.queryByTestId('layout-hint-banner')).toBeNull());
  });

  it("with a commit-graph, not tricky even on 120 000 commits", async () => {
    await openShell({ log_page: () => makeLogPage(60, 60, 0, 120_000) });
    expect(screen.queryByTestId('layout-hint-banner')).toBeNull();
  });
});
