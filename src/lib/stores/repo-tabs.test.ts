import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import App from '../../App.svelte';
import { bootstrap } from '../bootstrap';
import { whenIdle } from '../activity';
import { installErrorRouting } from '../errors/handle';
import { app } from './app.svelte';
import { captureStores } from './context';
import { repo } from './repo.svelte';
import { activeSession } from './session.svelte';
import { toast } from './toast.svelte';
import { wireEvents, unwireEvents } from './wiring';
import { dialogStack } from '../dialogs/stack.svelte';
import { createFakeTransport, type FakeTransport } from '../test/fake-transport';
import { makeAppInfo, makeConflictState, makeLogPage, makeRefs, makeRepoInfo, makeStatus, makeUndo, oid } from '../test/fixtures';
import { resetAll } from '../test/reset';
import '../register-core';
import '../register-domains';

let fake: FakeTransport;
let saved: unknown;
let nextId: number;
const paths = new Map<string, number>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  resetAll({ keepRegistrations: true });
  installErrorRouting();
  paths.clear();
  nextId = 1;
  saved = null;
  fake = createFakeTransport({
    app_info: () => makeAppInfo(),
    settings_get: () => ({ 'workspace.tabs': saved }),
    settings_set: (args) => { if (args.key === 'workspace.tabs') saved = args.value; return null; },
    repo_open: (args) => {
      const path = args.path === '/alias-a' ? '/a' : String(args.path);
      if (path === '/missing') throw { code: 'NOT_FOUND', message: "Folder not found", details: { what: 'path', path } };
      if (!paths.has(path)) paths.set(path, nextId++);
      return makeRepoInfo({ id: paths.get(path)!, workdir: path, name: path.slice(1) });
    },
    repo_close: () => null,
    repo_recent_list: () => [],
    log_page: () => makeLogPage(),
    refs_list: () => makeRefs(),
    remote_list: () => [],
    stash_list: () => [],
    status_get: () => makeStatus({ files: [] }),
    undo_peek: () => makeUndo(false),
  }).install();
  app.load({});
  app.ready = true;
  wireEvents();
});
afterEach(async () => { await app.flush(); unwireEvents(); });

async function open(path: string) {
  expect(await repo.open(path)).toBe(true);
  await whenIdle();
  return captureStores();
}

describe('repository tabs', () => {
  it('adds projects without closing them and restores their independent view and draft', async () => {
    const a = await open('/a');
    a.graph.selectCommit(oid(7));
    a.graph.scrollTop = 1234;
    a.graph.searchOpen = true;
    a.graph.searchQuery = 'feature';
    a.ui.openCenter('diff', { path: 'a.txt', source: { kind: 'unstaged' } });
    a.commitForm.summary = 'Draft A';
    a.commitForm.body = 'Details A';
    const b = await open('/b');
    b.commitForm.summary = 'Draft B';
    expect(b.graph.selection.kind).toBe('none');
    expect(b.ui.centerView.id).toBe('graph');
    expect(fake.callsOf('repo_close')).toHaveLength(0);
    expect(repo.tabs).toHaveLength(2);
    repo.activate(a.session);
    expect(captureStores().graph).toBe(a.graph);
    expect(a.graph.singleCommitOid).toBe(oid(7));
    expect(a.graph.scrollTop).toBe(1234);
    expect(a.graph.searchQuery).toBe('feature');
    expect(a.ui.centerView.props.path).toBe('a.txt');
    expect(a.commitForm.summary).toBe('Draft A');
    expect(a.commitForm.body).toBe('Details A');
    expect(b.commitForm.summary).toBe('Draft B');
  });

  it('reuses existing tabs including canonical path aliases', async () => {
    const a = await open('/a');
    await open('/b');
    await open('/a');
    expect(repo.tabs).toHaveLength(2);
    expect(activeSession.current).toBe(a.session);
    expect(fake.callsOf('repo_open')).toHaveLength(2);
    await open('/alias-a');
    expect(repo.tabs).toHaveLength(2);
    expect(activeSession.current).toBe(a.session);
    expect(fake.callsOf('repo_close')).toHaveLength(0);
  });

  it('closes an inactive tab without changing the active project; last close returns home', async () => {
    const a = await open('/a');
    const b = await open('/b');
    render(App);
    await repo.close(a.session);
    expect(activeSession.current).toBe(b.session);
    expect(fake.callsOf('repo_close').at(-1)?.args.repoId).toBe(1);
    await repo.close(b.session);
    expect(repo.tabs).toHaveLength(0);
    expect(repo.isOpen).toBe(false);
    expect(await screen.findByTestId('welcome-open-btn')).toBeInTheDocument();
    await app.flush();
    expect(saved).toEqual({ paths: [], activePath: null });
  });

  it('selects the right neighbour, then the left neighbour when closing the active tab', async () => {
    const a = await open('/a');
    const b = await open('/b');
    const c = await open('/c');
    repo.activate(b.session);
    await repo.close();
    expect(activeSession.current).toBe(c.session);
    await repo.close();
    expect(activeSession.current).toBe(a.session);
  });

  it('keeps operations and progress on their originating tab while allowing work elsewhere', async () => {
    const a = await open('/a');
    const pending = deferred<void>();
    const result = a.runWrite('Fetch A', () => pending.promise, { long: true, command: 'remote_fetch' });
    const opId = a.op.inflight!.opId!;
    const b = await open('/b');
    fake.emit('op:progress', { opId, label: 'Fetching A', percent: 42 });
    expect(a.op.inflight?.percent).toBe(42);
    expect(b.op.busy).toBe(false);
    expect((await b.runWrite('Stage B', async () => true)).ok).toBe(true);
    await repo.close(a.session);
    expect(repo.tabs).toContain(a.session);
    expect(fake.callsOf('repo_close')).toHaveLength(0);
    pending.resolve();
    expect((await result).ok).toBe(true);
    expect(a.op.busy).toBe(false);
    expect(activeSession.current).toBe(b.session);
  });

  it('applies late reads and events to their original session, including inactive repositories', async () => {
    const pending = deferred<ReturnType<typeof makeStatus>>();
    fake.on('status_get', (args) => args.repoId === 1 ? pending.promise : makeStatus({ files: [], ahead: 2 }));
    await repo.open('/a');
    const a = captureStores();
    await repo.open('/b');
    const b = captureStores();
    pending.resolve(makeStatus({ files: [], ahead: 99 }));
    await whenIdle();
    expect(a.status.ahead).toBe(99);
    expect(b.status.ahead).toBe(2);
    fake.calls.length = 0;
    fake.emit('repo:changed', { repoId: 1, kinds: ['index'] });
    fake.emit('op:state', { repoId: 1, state: makeConflictState() });
    await whenIdle();
    expect(a.op.state?.kind).toBe('rebase');
    expect(b.op.state).toBeNull();
    expect(fake.callsOf('status_get').every((call) => call.args.repoId === 1)).toBe(true);
  });

  it('ignores a rejected read from a closed tab without damaging the active repository', async () => {
    const pending = deferred<ReturnType<typeof makeStatus>>();
    fake.on('status_get', (args) => args.repoId === 1 ? pending.promise : makeStatus({ files: [] }));
    await repo.open('/a');
    const a = captureStores();
    await repo.open('/b');
    const b = captureStores();
    await repo.close(a.session);
    expect(await a.openDialog('branch-create-dialog')).toBeUndefined();
    expect(dialogStack.entries).toHaveLength(0);
    pending.reject({ code: 'NOT_FOUND', message: 'A disappeared', details: { what: 'workdir' } });
    await whenIdle();
    expect(b.repo.missing).toBe(false);
    expect(toast.items).toHaveLength(0);
  });

  it('routes background conflicts to their original project', async () => {
    const a = await open('/a');
    const b = await open('/b');
    const result = await a.runWrite('Pull A', async () => {
      throw { code: 'CONFLICT', message: 'Conflit A', details: { state: makeConflictState() } };
    }, { command: 'remote_pull' });
    expect(result.ok).toBe(false);
    expect(a.op.state?.kind).toBe('rebase');
    expect(a.graph.selection.kind).toBe('wip');
    expect(b.op.state).toBeNull();
    expect(b.graph.selection.kind).toBe('none');
    expect(activeSession.current).toBe(b.session);
    expect(a.session.attention).toBe(true);
    toast.items.at(-1)!.actions[0]!.run();
    expect(activeSession.current).toBe(a.session);
  });

  it('keeps retries attached to the original repository after switching tabs', async () => {
    const a = await open('/a');
    const calls: number[] = [];
    let attempt = 0;
    await a.runWrite('Push A', async () => {
      calls.push(a.session.repoId!);
      if (++attempt === 1) throw { code: 'BUSY', message: 'Lock A', details: { reason: 'lock', lockFile: '/a/.git/index.lock' } };
      return true;
    }, { command: 'remote_push' });
    const retry = toast.items.at(-1)!.actions.find((action) => action.testid === 'toast-retry-btn')!;
    const b = await open('/b');
    await retry.run();
    expect(calls).toEqual([1, 1]);
    expect(activeSession.current).toBe(b.session);
    expect(b.op.busy).toBe(false);
  });

  it('reports interactive background errors with View instead of opening a modal over another project', async () => {
    const a = await open('/a');
    const b = await open('/b');
    render(App);
    await a.runWrite('Pull A', async () => {
      throw { code: 'DIRTY_WORKTREE', message: 'Dirty A', details: { paths: ['a.txt'] } };
    }, { command: 'remote_pull' });
    expect(dialogStack.entries).toHaveLength(0);
    expect(activeSession.current).toBe(b.session);
    await fireEvent.click(await screen.findByTestId('toast-view-repo-btn'));
    await waitFor(() => expect(dialogStack.top?.id).toBe('pull-autostash-dialog'));
    expect(activeSession.current).toBe(a.session);
    dialogStack.closeAll();
  });

  it('persists order and active path; restores the active repository first without changing visual order', async () => {
    const a = await open('/a');
    const b = await open('/b');
    await open('/c');
    repo.activate(b.session);
    await app.flush();
    expect(saved).toEqual({ paths: ['/a', '/b', '/c'], activePath: '/b' });
    const workspace = app.get('workspace.tabs');
    repo.reset();
    fake.calls.length = 0;
    await repo.restore(workspace, null);
    await whenIdle();
    expect(fake.callsOf('repo_open').map((call) => call.args.path)).toEqual(['/b', '/a', '/c']);
    expect(repo.tabs.map((tab) => tab.info?.workdir)).toEqual(['/a', '/b', '/c']);
    expect(repo.info?.workdir).toBe('/b');
    expect(activeSession.current).not.toBe(a.session);
  });

  it('gives an explicit launch path priority and skips unavailable saved repositories', async () => {
    await repo.restore({ paths: ['/a', '/missing', '/b'], activePath: '/missing' }, '/c');
    await whenIdle();
    expect(repo.info?.workdir).toBe('/c');
    expect(repo.tabs.map((tab) => tab.info?.workdir)).toEqual(['/a', '/b', '/c']);
    expect(toast.items.at(-1)?.message).toContain('/missing');
  });

  it('keeps saved order when an explicit launch path aliases an already saved tab', async () => {
    await repo.restore({ paths: ['/a', '/b'], activePath: '/b' }, '/alias-a');
    await whenIdle();
    expect(repo.tabs.map((tab) => tab.info?.workdir)).toEqual(['/a', '/b']);
    expect(activeSession.current.info?.workdir).toBe('/a');
    expect(fake.callsOf('repo_close')).toHaveLength(0);
  });

  it('preserves an existing tab when a new opening fails', async () => {
    const a = await open('/a');
    expect(await repo.open('/missing')).toBe(false);
    expect(activeSession.current).toBe(a.session);
    expect(repo.tabs).toHaveLength(1);
    expect(fake.callsOf('repo_close')).toHaveLength(0);
  });

  it('starts at home for a saved empty workspace, even when recent repositories exist', async () => {
    saved = { paths: [], activePath: null };
    fake.on('repo_recent_list', () => [{ path: '/a', name: 'a', lastOpened: '2026-10-03' }]);
    render(App);
    await bootstrap();
    expect(await screen.findByTestId('welcome-open-btn')).toBeInTheDocument();
    expect(fake.callsOf('repo_open')).toHaveLength(0);
  });

  it('renders tabs, plus menu, close controls and keyboard navigation', async () => {
    const a = await open('/a');
    const b = await open('/b');
    render(App);
    const tabs = await screen.findAllByRole('tab');
    expect(tabs[0]).toHaveAttribute('aria-selected', 'false');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    await fireEvent.keyDown(tabs[1]!, { key: 'ArrowLeft' });
    expect(activeSession.current).toBe(a.session);
    await fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true });
    expect(activeSession.current).toBe(b.session);
    await fireEvent.click(screen.getByTestId('repo-tabs-add-btn'));
    expect(screen.getByTestId('repo-tabs-open-btn')).toBeInTheDocument();
    expect(screen.getByTestId('repo-tabs-clone-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('toolbar-repo-switcher')).toBeNull();
  });
});
