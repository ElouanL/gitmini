// Stores and refreshments on `repo:changed` (03 "Refreshment", ).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installErrorRouting } from '../errors/handle';
import { commands } from '../ipc/commands';
import { whenIdle } from '../activity';
import { createFakeTransport, type FakeTransport } from '../test/fake-transport';
import { makeAppInfo, makeConflictState, makeLogPage, makeRefs, makeRemotes, makeRepoInfo, makeStashes, makeStatus, makeUndo, oid } from '../test/fixtures';
import { resetAll } from '../test/reset';
import { app } from './app.svelte';
import { graph } from './graph.svelte';
import { op } from './op.svelte';
import { refs } from './refs.svelte';
import { repo } from './repo.svelte';
import { runWrite } from './run-write';
import { session } from './session.svelte';
import { status } from './status.svelte';
import { toast } from './toast.svelte';
import { ui } from './ui.svelte';
import { undo } from './undo.svelte';
import { handleRepoChanged, unwireEvents, wireEvents } from './wiring';
import { createCoalescer } from './schedule';

let fake: FakeTransport;

function backend(): FakeTransport {
  return createFakeTransport({
    app_info: () => makeAppInfo(),
    settings_get: () => ({}),
    repo_recent_list: () => [],
    repo_open: () => makeRepoInfo(),
    repo_close: () => null,
    log_page: () => makeLogPage(),
    refs_list: () => makeRefs(),
    remote_list: () => makeRemotes(),
    stash_list: () => makeStashes(),
    status_get: () => makeStatus(),
    undo_peek: () => makeUndo(),
    settings_set: () => null,
  }).install();
}

beforeEach(() => {
  resetAll();
  installErrorRouting();
  fake = backend();
  wireEvents();
});

afterEach(() => {
  unwireEvents();
  vi.useRealTimers();
});

describe("opening of a repository", () => {
  it("repo_open then log, refs, remotes, stashes, status and undo in parallel", async () => {
    expect(await repo.open('/r')).toBe(true);
    await whenIdle();
    const cmds = fake.calls.map((c) => c.command);
    for (const c of ['repo_open', 'log_page', 'refs_list', 'remote_list', 'stash_list', 'status_get', 'undo_peek']) expect(cmds).toContain(c);
    expect(cmds[0]).toBe('repo_open');
    expect(repo.id).toBe(1);
    expect(graph.pages).toHaveLength(1);
    expect(refs.snapshot?.local).toHaveLength(4);
    expect(refs.stashes).toHaveLength(2);
    expect(status.snapshot?.files).toHaveLength(3);
    expect(undo.available).toBe(true);
    expect(repo.head).toMatchObject({ branch: 'main', detached: false });
  });

  it("RepoInfo.opState directly feeds the store op", async () => {
    fake.on('repo_open', () => makeRepoInfo({ opState: makeConflictState() }));
    await repo.open('/r');
    expect(op.state?.kind).toBe('rebase');
  });

  it("another repository adds tab without closing current", async () => {
    await repo.open('/a');
    await repo.open('/b');
    const names = fake.calls.map((c) => c.command).filter((c) => c === 'repo_open' || c === 'repo_close');
    expect(names).toEqual(['repo_open', 'repo_open']);
  });

  it.each([
    ['NOT_A_REPO', { path: '/r', reason: 'bare' }, 'bare'],
    ['UNSUPPORTED_REPO_FORMAT', { path: '/r', reason: 'sha256' }, 'sha256'],
    ['NOT_A_REPO', { path: '/r', reason: 'dubious-ownership' }, 'dubious-ownership'],
  ] as const)("failure %s → welcome-open-error, no toast, recent replays", async (code, details, reason) => {
    fake.reject('repo_open', { code, message: 'refus', details });
    expect(await repo.open('/r')).toBe(false);
    expect(repo.openError).toMatchObject({ code, reason });
    expect(toast.items).toHaveLength(0);
    expect(fake.callsOf('repo_recent_list').length).toBeGreaterThan(0);
    expect(repo.isOpen).toBe(false);
  });

  it('NOT_FOUND { path } → welcome-open-error', async () => {
    fake.reject('repo_open', { code: 'NOT_FOUND', message: 'absent', details: { what: 'path' } });
    await repo.open('/gone');
    expect(repo.openError?.code).toBe('NOT_FOUND');
  });

  it("a closed repository response is ignored (session generation)", async () => {
    let release!: () => void;
    fake.on('status_get', () => new Promise((r) => (release = () => r(makeStatus({ ahead: 99 })))));
    await repo.open('/a');
    await repo.close();
    release();
    await whenIdle();
    expect(status.snapshot).toBeNull();
  });
});

describe("Repo:changed targeted refreshment", () => {
  beforeEach(async () => {
    await repo.open('/r');
    await whenIdle();
    fake.calls.length = 0;
  });

  const run = async (kinds: ('refs' | 'index' | 'worktree' | 'head' | 'stash')[]) => {
    handleRepoChanged({ repoId: 1, kinds });
    await whenIdle();
    return fake.calls.map((c) => c.command);
  };

  it("index / worktree → status_get only (+ undo_peek)", async () => {
    const cmds = await run(['worktree']);
    expect(cmds).toContain('status_get');
    expect(cmds).not.toContain('refs_list');
    expect(cmds).not.toContain('log_page');
    expect(cmds).toContain('undo_peek');
  });

  it("refs → refs_list, then visible page of the graph; remote_list", async () => {
    const cmds = await run(['refs']);
    expect(cmds.indexOf('refs_list')).toBeLessThan(cmds.indexOf('log_page'));
    expect(cmds).toContain('remote_list');
    expect(cmds).not.toContain('stash_list');
  });

  it("head → refs_list + log_page without remote_list", async () => {
    const cmds = await run(['head']);
    expect(cmds).toContain('refs_list');
    expect(cmds).toContain('log_page');
    expect(cmds).not.toContain('remote_list');
  });

  it("stash → stash_list then visible page of the graph", async () => {
    const cmds = await run(['stash']);
    expect(cmds.indexOf('stash_list')).toBeLessThan(cmds.indexOf('log_page'));
    expect(cmds).not.toContain('refs_list');
  });

  it("one event from another repository is ignored", async () => {
    handleRepoChanged({ repoId: 99, kinds: ['refs', 'index'] });
    await whenIdle();
    expect(fake.calls).toHaveLength(0);
  });

  it("via the bus: fake.emit triggers the same refreshment", async () => {
    fake.emit('repo:changed', { repoId: 1, kinds: ['index'] });
    await whenIdle();
    expect(fake.callsOf('status_get')).toHaveLength(1);
  });

  it("op:state updates the banner directly; op:progress the progress of the flight command", async () => {
    fake.emit('op:state', { repoId: 1, state: makeConflictState() });
    expect(op.state?.step).toBe(3);
    fake.emit('op:state', { repoId: 1, state: null });
    expect(op.state).toBeNull();

    const end = op.begin('Fetch', 'abc');
    fake.emit('op:progress', { opId: 'abc', label: 'Receiving objects', percent: 40 });
    expect(op.inflight).toMatchObject({ progressLabel: 'Receiving objects', percent: 40 });
    fake.emit('op:progress', { opId: "other", label: 'x', percent: 99 });
    expect(op.inflight?.percent).toBe(40);
    end();
    expect(op.inflight).toBeNull();
  });

  it("undo_peek is off at 50 ms", async () => {
    vi.useFakeTimers();
    undo.peekSoon();
    undo.peekSoon();
    undo.peekSoon();
    await vi.advanceTimersByTimeAsync(49);
    expect(fake.callsOf('undo_peek')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(fake.callsOf('undo_peek')).toHaveLength(1);
  });

  it("a gust of events during a status_get once again at the end", async () => {
    let release!: () => void;
    fake.on('status_get', () => new Promise((r) => (release = () => r(makeStatus()))));
    const first = status.refresh();
    status.refresh();
    status.refresh();
    expect(fake.callsOf('status_get')).toHaveLength(1);
    release();
    await new Promise((r) => setTimeout(r, 0));
    release();
    await first;
    await whenIdle();
    expect(fake.callsOf('status_get')).toHaveLength(2);
  });
});

describe('coalescence', () => {
  it("not more than one flight execution and one waiting", async () => {
    let runs = 0;
    const gates: (() => void)[] = [];
    const c = createCoalescer(() => new Promise<void>((r) => (runs++, gates.push(r))));
    const p1 = c.trigger();
    const p2 = c.trigger();
    const p3 = c.trigger();
    expect(runs).toBe(1);
    gates[0]!();
    await new Promise((r) => setTimeout(r, 0));
    expect(runs).toBe(2);
    gates[1]!();
    await Promise.all([p1, p2, p3]);
    expect(runs).toBe(2);
  });
});

describe('runWrite (01 §4.2)', () => {
  it("pose op.inflight while ordering, no optimistic update, removes at the end", async () => {
    let release!: (v: string) => void;
    const p = runWrite('Commit', () => new Promise<string>((r) => (release = r)));
    expect(op.inflight?.label).toBe('Commit');
    expect(op.blockReason('write')).toBe("Operation in progress: Commit");
    release('ok');
    expect(await p).toEqual({ ok: true, value: 'ok' });
    expect(op.inflight).toBeNull();
  });

  it("one write disables others: the second is refused locally by BUSY, without running", async () => {
    let release!: () => void;
    const first = runWrite('Fetch', () => new Promise<void>((r) => (release = r)));
    const fn = vi.fn();
    const second = await runWrite('Stash', fn);
    expect(fn).not.toHaveBeenCalled();
    expect(second).toMatchObject({ ok: false, error: { code: 'BUSY' } });
    expect(toast.items.at(-1)).toMatchObject({ kind: 'error', title: "Operation in progress" });
    release();
    await first;
  });

  it("a rejection passes by handleError and is returned; the in flight state is released", async () => {
    const r = await runWrite('Push', () => Promise.reject({ code: 'NETWORK', message: 'injoignable', details: {} }));
    expect(r).toMatchObject({ ok: false, error: { code: 'NETWORK' } });
    expect(toast.items.at(-1)).toMatchObject({ kind: 'error', title: "Unreachable network" });
    expect(op.inflight).toBeNull();
  });

  it("command [L]: an opId UUID is supplied and attached to op.inflight", async () => {
    let seen: string | null = null;
    let cancelId: string | null = null;
    const p = runWrite('Fetch', async ({ opId }) => {
      seen = opId;
      cancelId = op.inflight?.opId ?? null;
    }, { long: true });
    await p;
    expect(seen).toMatch(/^[0-9a-f-]{36}$/);
    expect(cancelId).toBe(seen);
  });

  it("toast-retry-btn restarts the same command (BUSY lock)", async () => {
    let n = 0;
    await runWrite('Index', () => (n++ === 0 ? Promise.reject({ code: 'BUSY', message: 'verrou', details: { reason: 'lock', lockFile: 'index.lock' } }) : Promise.resolve(1)));
    const retry = toast.items.at(-1)!.actions.find((a) => a.testid === 'toast-retry-btn')!;
    await retry.run();
    expect(n).toBe(2);
  });

  it("commands.* is the only way to transport (the newspaper proves it)", async () => {
    await runWrite('Test', () => commands.stagePaths({ repoId: 1, paths: ['a'] }).catch(() => null));
    expect(fake.callsOf('stage_paths')).toHaveLength(1);
  });
});

describe("settings", () => {
  it("app.set applies immediately and then writes after 300 ms; close values merge", async () => {
    vi.useFakeTimers();
    app.load({});
    const p = app.set('theme', 'dark');
    void app.set('theme', 'light');
    expect(document.documentElement.dataset.theme).toBe('light');
    await vi.advanceTimersByTimeAsync(299);
    expect(fake.callsOf('settings_set')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    await p;
    expect(fake.callsOf('settings_set')).toEqual([{ command: 'settings_set', args: { key: 'theme', value: 'light' } }]);
  });

  it("a rejected value (INVALID_ARGUMENT) is returned to the field and cancelled locally", async () => {
    vi.useFakeTimers();
    app.load({ 'editor.command': null });
    fake.reject('settings_set', { code: 'INVALID_ARGUMENT', message: "must contain {path}", details: { field: 'value' } });
    const p = app.set('editor.command', 'vim', { optimistic: false });
    await vi.advanceTimersByTimeAsync(301);
    const e = await p;
    expect(e?.code).toBe('INVALID_ARGUMENT');
    expect(app.get('editor.command')).toBeNull();
    expect(toast.items).toHaveLength(0);
  });

  it("theme.toggle and `system` : data-theme is always light or dark", () => {
    app.load({ theme: 'dark' });
    expect(document.documentElement.dataset.theme).toBe('dark');
    app.load({ theme: 'light' });
    expect(document.documentElement.dataset.theme).toBe('light');
    app.load({ theme: 'system' });
    expect(['light', 'dark']).toContain(document.documentElement.dataset.theme);
  });
});

describe("selection of the graph", () => {
  it("oid selection: simple, Mod+click (bass), WIP, stash", () => {
    graph.selectCommit(oid(5));
    expect(graph.singleCommitOid).toBe(oid(5));
    graph.toggleCommit(oid(6));
    expect(graph.selectedOids).toEqual([oid(5), oid(6)]);
    graph.toggleCommit(oid(5));
    expect(graph.selectedOids).toEqual([oid(6)]);
    graph.selectWip();
    expect(graph.selection.kind).toBe('wip');
    graph.selectStash(oid(900), 0);
    expect(graph.selection).toEqual({ kind: 'stash', oid: oid(900), index: 0 });
    graph.clearSelection();
    expect(graph.selection.kind).toBe('none');
  });

  it("not more than 6 pages are kept", () => {
    graph.setPages(Array.from({ length: 9 }, (_, i) => makeLogPage(60 - i * 5, 5, i * 5)));
    expect(graph.pages).toHaveLength(6);
  });

  it("dream : without IPC if line is loaded, otherwise log_page { aroundOid }", async () => {
    session.begin(1);
    graph.setPages([makeLogPage(60, 10)]);
    fake.calls.length = 0;
    await graph.reveal(oid(55));
    expect(fake.calls).toHaveLength(0);
    expect(graph.revealRequest?.oid).toBe(oid(55));
    await graph.reveal(oid(5));
    expect(fake.callsOf('log_page')[0]!.args).toMatchObject({ aroundOid: oid(5) });
  });
});

describe("gradient mode of the watcher (02 §5.1) and recovered settings", () => {
  beforeEach(async () => {
    await repo.open('/r');
    await whenIdle();
  });

  it("StatusSnapshot.watcherDegraded: watcher-degraded tip displayed / removed", async () => {
    fake.on('status_get', () => makeStatus({ watcherDegraded: true }));
    await status.refresh();
    expect(status.watcherDegraded).toBe(true);
    expect(ui.activeHints).toContain('watcher-degraded');
    fake.on('status_get', () => makeStatus({ watcherDegraded: false }));
    await status.refresh();
    expect(ui.activeHints).not.toContain('watcher-degraded');
  });

  it("status_get restarted every 5 seconds as long as the window has the focus, and when the focus returns", async () => {
    vi.useFakeTimers();
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    fake.on('status_get', () => makeStatus({ watcherDegraded: true }));
    await status.refresh();
    fake.calls.length = 0;
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.callsOf('status_get')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.callsOf('status_get')).toHaveLength(2);

    // Loss of focus: no more survey.
    window.dispatchEvent(new Event('blur'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fake.callsOf('status_get')).toHaveLength(2);
    // Back to focus: immediate rereading, then resume survey.
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.callsOf('status_get')).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.callsOf('status_get')).toHaveLength(4);

    // Retour au mode normal : plus de sondage.
    fake.on('status_get', () => makeStatus({ watcherDegraded: false }));
    await vi.advanceTimersByTimeAsync(5000);
    fake.calls.length = 0;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fake.callsOf('status_get')).toHaveLength(0);
    hasFocus.mockRestore();
  });

  it("close the repository stops the survey and masks trick", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    fake.on('status_get', () => makeStatus({ watcherDegraded: true }));
    await status.refresh();
    await repo.close();
    fake.calls.length = 0;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fake.callsOf('status_get')).toHaveLength(0);
    expect(ui.activeHints).not.toContain('watcher-degraded');
  });

  it("AppInfo.settingsRecovered : toast d'information « Settings restored »", async () => {
    resetAll();
    installErrorRouting();
    fake = backend();
    fake.on('app_info', () => makeAppInfo({ settingsRecovered: true }));
    const { bootstrap } = await import('../bootstrap');
    await bootstrap();
    expect(toast.items.at(-1)).toMatchObject({ kind: 'info', message: "Settings restored" });
    fake.on('app_info', () => makeAppInfo({ settingsRecovered: false }));
    toast.clear();
    await bootstrap();
    expect(toast.items).toHaveLength(0);
  });
});

describe("full graph index (ahead/behind null until then)", () => {
  it("first announcement of a non-zero total: refs_list and status_get are read once", async () => {
    let indexReady = false;
    const refsWithCounts = () => makeRefs();
    const refsWithoutCounts = () => {
      const r = makeRefs();
      return { ...r, local: r.local.map((b) => (b.upstream ? { ...b, upstream: { ...b.upstream, ahead: null, behind: null } } : b)) };
    };
    fake.on('refs_list', () => (indexReady ? refsWithCounts() : refsWithoutCounts()));
    fake.on('status_get', () => (indexReady ? makeStatus() : makeStatus({ ahead: null, behind: null })));
    fake.on('log_page', () => makeLogPage(60, 60, 0, null)); // total inconnu : l'index se construit
    await repo.open('/r');
    await whenIdle();
    expect(refs.snapshot!.local[0]!.upstream!.ahead).toBeNull();
    expect(status.ahead).toBeNull();

    // the index ends: the next page announces the total (no backend event)
    indexReady = true;
    fake.calls.length = 0;
    graph.setPages([makeLogPage(60, 60, 0, 60)]);
    await whenIdle();
    expect(fake.callsOf('refs_list')).toHaveLength(1);
    expect(fake.callsOf('status_get')).toHaveLength(1);
    expect(refs.snapshot!.local[0]!.upstream!.ahead).toBe(1);
    expect(status.ahead).toBe(1);
    expect(status.behind).toBe(2);

    // only once: the following pages do not read anything again
    fake.calls.length = 0;
    graph.setPages([makeLogPage(60, 60, 0, 60)]);
    await whenIdle();
    expect(fake.calls.filter((c) => c.command === 'refs_list' || c.command === 'status_get')).toHaveLength(0);
  });

  it("repository closed entre-temps: no revision", async () => {
    fake.on('log_page', () => makeLogPage(60, 60, 0, null));
    await repo.open('/r');
    await whenIdle();
    await repo.close();
    fake.calls.length = 0;
    graph.setPages([makeLogPage(60, 60, 0, 60)]);
    await whenIdle();
    expect(fake.calls.filter((c) => c.command === 'refs_list' || c.command === 'status_get')).toHaveLength(0);
  });
});
