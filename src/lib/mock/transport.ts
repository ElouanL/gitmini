// Transport in memory to see the IU without backend: `pnpm dev` then http://localhost:1420/?mock=1 (development SEULEMENT:
// never included in the production build, `bootstrap.ts` is just behind `import.meta.env.DEV`).
// Scenarios: `?mock=1&scenario=`  `default` - I'm sorry. `conflict` - I'm sorry. `detached` - I'm sorry. `empty` - I'm sorry. `gitold` - I'm sorry. `gitmissing` - I'm sorry. `slow` - I'm sorry. `degraded` - I'm sorry. `recovered` .
// Driver from console: `__mock.emit('repo:changed', { repoId: 1, kinds: ['refs'] })`, `__mock.state`.
import { dispatchEvent, type EventMap } from '../ipc/events';
import type { EventName, Transport, Unlisten } from '../ipc/transport';
import type { AppError, RepoInfo, RepoOpState } from '../ipc/types';
import {
  makeAppInfo, makeConflictState, makeLogPage, makeRecents, makeRefs, makeRemotes, makeRepoInfo, makeStashes, makeStatus, makeUndo, oid,
} from '../test/fixtures';
import { DEFAULT_SETTINGS } from '../ipc/settings-types';

const err = (code: AppError['code'], message: string, details: Record<string, unknown> = {}): AppError => ({ code, message, details });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createMockTransport(): Transport {
  const params = new URLSearchParams(location.search);
  const scenario = params.get('scenario') ?? 'default';
  const listeners = new Map<EventName, Set<(p: unknown) => void>>();
  const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  let opState: RepoOpState | null = scenario === 'conflict' ? makeConflictState() : null;
  let refs = makeRefs();
  if (scenario === 'detached') refs = { ...refs, head: { kind: 'detached', oid: oid(42) }, local: refs.local.map((b) => ({ ...b, isHead: false })) };
  let stashes = scenario === 'empty' ? [] : makeStashes();
  let status = scenario === 'empty' ? makeStatus({ files: [], upstream: null, ahead: null, behind: null }) : makeStatus();
  const recents = makeRecents();
  const repoIds = new Map<string, number>();
  const initialized = new Set<string>(); // folders `repo_init` has turned into repositories

  const emit = <N extends EventName>(name: N, payload: EventMap[N]) => {
    for (const l of listeners.get(name) ?? []) l(payload);
    dispatchEvent(name, payload as never);
  };

  const repoInfo = (path: string): RepoInfo =>
    makeRepoInfo({
      id: repoIds.get(path) ?? (() => { const id = repoIds.size + 1; repoIds.set(path, id); return id; })(),
      workdir: path, name: path.split('/').filter(Boolean).pop() ?? 'repo', opState,
      head: scenario === 'detached' ? { branch: null, oid: oid(42), detached: true, unborn: false } : { branch: 'main', oid: oid(60), detached: false, unborn: false },
    });

  const handlers: Record<string, (a: Record<string, unknown>) => unknown | Promise<unknown>> = {
    app_info: () => {
      if (scenario === 'gitold') return makeAppInfo({ gitError: 'GIT_TOO_OLD', git: { path: '/usr/bin/git', version: '2.25.1' } });
      if (scenario === 'gitmissing') return makeAppInfo({ gitError: 'GIT_MISSING', git: null });
      return makeAppInfo({ initialPath: params.get('path'), settingsRecovered: scenario === 'recovered' });
    },
    settings_get: () => ({ ...settings }),
    settings_set: (a) => {
      const key = String(a.key);
      if (key === 'editor.command' && typeof a.value === 'string' && !a.value.includes('{path}')) {
        throw err('INVALID_ARGUMENT', "The command must contain {path}", { field: 'value' });
      }
      settings[key] = a.value;
      return null;
    },
    repo_recent_list: () => recents,
    repo_open: async (a) => {
      const path = String(a.path);
      await sleep(scenario === 'slow' ? 1500 : 60);
      if (path.includes('missing')) throw err('NOT_FOUND', "Folder not found", { what: 'path', path });
      if (path.includes('bare')) throw err('NOT_A_REPO', "Bare depot", { path, reason: 'bare' });
      if (path.includes('sha256')) throw err('UNSUPPORTED_REPO_FORMAT', 'SHA-256 non pris en charge', { path, reason: 'sha256' });
      if (path.includes('dubious')) throw err('NOT_A_REPO', "Owner not safe", { path, reason: 'dubious-ownership' });
      if (path.includes('plain') && !initialized.has(path)) throw err('NOT_A_REPO', "Not a repository", { path });
      return repoInfo(path);
    },
    repo_init: async (a) => {
      const path = String(a.path);
      await sleep(60);
      initialized.add(path);
      return repoInfo(path);
    },
    repo_close: () => null,
    repo_activate: () => null,
    log_page: async (a) => {
      await sleep(40);
      return makeLogPage(a.aroundOid ? 60 : 60, 60, 0, 60);
    },
    refs_list: () => refs,
    remote_list: () => makeRemotes(),
    stash_list: () => stashes,
    status_get: () => (scenario === 'degraded' ? { ...status, watcherDegraded: true } : status),
    undo_peek: () => makeUndo(scenario !== 'empty'),
    commit_details: (a) => ({
      oid: String(a.oid), parents: [oid(Number.parseInt(String(a.oid).slice(-2), 16) - 1)], tree: oid(7777),
      author: { name: 'Alice Martin', email: 'alice@example.org', time: 1790000000, offsetMinutes: 120 },
      committer: { name: 'Alice Martin', email: 'alice@example.org', time: 1790000000, offsetMinutes: 120 },
      message: 'feat: login form\n\nAdds the login form and its validation.', files: [], truncated: false,
    }),
    stage_paths: () => status,
    unstage_paths: () => status,
    remote_fetch: async (a) => {
      for (const p of [20, 55, 90]) {
        emit('op:progress', { opId: String(a.opId), label: 'Receiving objects', percent: p });
        await sleep(350);
      }
      emit('repo:changed', { repoId: 1, kinds: ['refs'] });
      return null;
    },
    remote_pull: async () => {
      await sleep(600);
      return { head: { branch: 'main', oid: oid(61), detached: false, unborn: false } };
    },
    remote_push: async () => {
      await sleep(600);
      return null;
    },
    stash_save: () => {
      stashes = [{ ...makeStashes()[0]!, message: 'On main: nouveau stash' }, ...stashes];
      status = makeStatus({ files: [] });
      emit('repo:changed', { repoId: 1, kinds: ['stash', 'worktree', 'index'] });
      return { created: stashes[0]!, list: stashes };
    },
    stash_pop: () => {
      stashes = stashes.slice(1);
      emit('repo:changed', { repoId: 1, kinds: ['stash', 'worktree'] });
      return { conflicts: [], dropped: true, list: stashes };
    },
    branch_checkout: (a) => {
      const t = a.target as { kind: string; name?: string };
      if (t.kind === "local" && t.name) {
        refs = { ...refs, head: { kind: 'branch', name: t.name }, local: refs.local.map((b) => ({ ...b, isHead: b.name === t.name })) };
      }
      emit('repo:changed', { repoId: 1, kinds: ['head', 'refs'] });
      return refs;
    },
    rebase_abort: () => {
      opState = null;
      emit('op:state', { repoId: 1, state: null });
      return { head: { branch: 'main', oid: oid(60), detached: false, unborn: false } };
    },
    undo_last: () => ({ head: { branch: 'main', oid: oid(59), detached: false, unborn: false } }),
    github_status: () => ({ loggedIn: false, login: null }),
    op_cancel: () => null,
  };

  const transport: Transport = {
    kind: 'mock',
    async invoke(command, args) {
      const h = handlers[command];
      if (!h) throw err('GIT_FAILED', `Mock: command " ${command} » not simulated`, { command });
      return h(args);
    },
    async listen(event, handler): Promise<Unlisten> {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(handler);
      return () => set.delete(handler);
    },
  };

  (window as unknown as { __mock: unknown }).__mock = {
    emit,
    scenario,
    get state() {
      return { opState, refs, stashes, status };
    },
  };
  return transport;
}
