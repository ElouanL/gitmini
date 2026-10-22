// Transport in memory to see the IU without backend: `pnpm dev` then http://localhost:1420/?mock=1 (development SEULEMENT:
// never included in the production build, `bootstrap.ts` is just behind `import.meta.env.DEV`).
// Scenarios: `?mock=1&scenario=`  `default` - I'm sorry. `conflict` - I'm sorry. `detached` - I'm sorry. `empty` - I'm sorry. `gitold` - I'm sorry. `gitmissing` - I'm sorry. `slow` - I'm sorry. `degraded` - I'm sorry. `recovered` .
//   `folders`: many prefixed branches and tags, to try the sidebar folders and filter.
//   `conflict` also lists two conflicted files with their conflict diff (markers, ours, theirs; see ./conflict-sim.ts): "Take ours / theirs"
//   and "Mark as resolved" resolve them.
//   Tags can be created (annotated with a message), deleted (the toast undoes it) and pushed; pushing `v0.2.0` shows the
//   "remote already has a different tag" refusal.
//   `src/App.svelte` and `README.md` have a diff you can stage, unstage and discard by hunk or by line (see ./diff-sim.ts).
//   Whatever is discarded (a file, a hunk, some lines) is kept: the Discarded tab of the reflog drawer lists it and restores it.
//   Merging a branch into `main` (dialog, or drag it onto `main`) previews the outcome: `feature/login` would conflict in two files,
//   `fix/typo` merges cleanly, `topic` fast-forwards, `origin/main` is already merged.
//   `src/App.svelte` (added as `src/Main.svelte`, then renamed) and `README.md` have a history and a blame: the "History" and "Blame"
//   buttons of their diff, or a commit's file list (commits 12, 18, 24, 31, 37, 44, 48, 52), open them; "Follow renames" works.
//   "Edit message..." on a commit of `main` (menu, or the button next to the commit title) rewords it: the graph and the details show
//   the new message, and the undo toast puts the previous one back.
//   The palette (Mod+K) lists branches (`@`), commits (`#`, searched by subject or sha) and repositories (`/`); the commands
//   run last come first and are kept as the `palette.recent` setting.
// Driver from console: `__mock.emit('repo:changed', { repoId: 1, kinds: ['refs'] })`, `__mock.state`,
// `__mock.advanceAutoFetch(5 * 60_000)` (after choosing an interval in Settings: each background fetch finds one more upstream commit).
import { dispatchEvent, type EventMap } from '../ipc/events';
import type { EventName, Transport, Unlisten } from '../ipc/transport';
import type { AppError, BranchCompare, ConflictKind, ConflictView, DiscardedFile, DiscardSource, FileStatus, LogPage, MergePreview, RefsSnapshot, RepoInfo, RepoOpState, TagInfo, TodoItem, UndoStatus } from '../ipc/types';
import {
  makeAppInfo, makeBranch, makeConflictState, makeLogPage, makeRecents, makeRefs, makeRemotes, makeRepoInfo, makeStashes, makeStatus, makeUndo, oid,
} from '../test/fixtures';
import { DEFAULT_SETTINGS, DIFF_CONTEXT_CHOICES, FETCH_AUTO_CHOICES, type DiffContextSetting, type FetchAutoSetting } from '../ipc/settings-types';
import { autoFetch } from '../stores/auto-fetch';
import { conflictDiff } from './conflict-sim';
import { createDefaultDiffSim, type HunkRequest, type SimOp } from './diff-sim';
import { createHistorySim } from './history-sim';

const err = (code: AppError['code'], message: string, details: Record<string, unknown> = {}): AppError => ({ code, message, details });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The `folders` scenario: more branches and tags under shared prefixes, sorted as the backend does (current first). */
function withPrefixedRefs(base: RefsSnapshot): RefsSnapshot {
  const extra = ['feature/signup', 'feature/ui/button', 'feature/ui/modal', 'fix/crash', 'release/1.0', 'release/1.1', 'users/alice/spike'];
  const local = [...base.local, ...extra.map((name, i) => makeBranch(name, 50 - i))]
    .sort((a, b) => Number(b.isHead) - Number(a.isHead) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const remote = [...base.remote, ...['feature/signup', 'feature/ui/button', 'release/1.0'].map((name, i) => ({ remote: 'origin', name, fullRef: `refs/remotes/origin/${name}`, oid: oid(50 - i) }))]
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const tags = [
    ...base.tags,
    ...['release/1.1', 'release/1.0'].map((name, i) => ({ name, fullRef: `refs/tags/${name}`, oid: oid(30 + i), targetOid: oid(30 + i), annotated: false })),
  ];
  return { ...base, local, remote, tags };
}

/** Undo status offering to put `tag` back (the backend keeps one level, like this mock). */
function tagDeleteUndo(tag: TagInfo): UndoStatus {
  const base = makeUndo(true);
  return {
    ...base,
    entry: {
      ...base.entry!, id: `undo-tag-${tag.name}`, kind: 'tag-delete', label: `Restore the ${tag.name} tag`, effect: `Restore the ${tag.name} tag on ${tag.targetOid.slice(0, 7)} (local only).`,
      refName: tag.fullRef, before: tag.oid, after: null, upstreamRef: null, upstreamAtOp: null,
    },
  };
}

/** Undo status offering to put back the messages a reword replaced (kind `rebase`, as the interactive rebase records it). */
function rewordUndo(): UndoStatus {
  const base = makeUndo(true);
  return { ...base, entry: { ...base.entry!, id: 'undo-reword', kind: 'rebase', label: 'Undo the rebase of main', effect: 'Put main back as it was before the rebase.', before: oid(60), after: oid(60) } };
}

/** One more commit on the current branch's upstream (`n`th), as a background fetch would bring in; `n = 0` clears what is behind. */
function withUpstreamNews(base: RefsSnapshot, n: number): RefsSnapshot {
  const head = base.local.find((b) => b.isHead);
  const up = head?.upstream;
  if (!head || !up || up.behind === null) return base;
  const behind = n === 0 ? 0 : up.behind + 1;
  return {
    ...base,
    local: base.local.map((b) => (b === head ? { ...b, upstream: { ...up, behind } } : b)),
    remote: base.remote.map((r) => (r.fullRef === `refs/remotes/${up.ref}` ? { ...r, oid: oid(70 + n) } : r)),
  };
}

/** The `conflict` scenario lists the files of `makeConflictState` in the Conflicts section. */
function conflictFile(path: string, conflict: ConflictKind): FileStatus {
  return { path, oldPath: null, staged: null, unstaged: null, conflict, oldMode: null, newMode: null, submodule: null, nonUtf8: null };
}

/** How each branch relates to `main` in the mock, and what merging it into `main` would do (see `merge_preview`). */
const MERGES: Record<string, { ahead: number; behind: number; preview: Pick<MergePreview, 'kind' | 'conflicts'> }> = {
  'feature/login': {
    ahead: 1, behind: 3,
    preview: { kind: 'conflicts', conflicts: [{ path: 'src/App.svelte', kind: 'content' }, { path: 'docs/old-notes.md', kind: 'modify-delete' }] },
  },
  'fix/typo': { ahead: 1, behind: 2, preview: { kind: 'clean', conflicts: [] } },
  topic: { ahead: 0, behind: 4, preview: { kind: 'fast-forward', conflicts: [] } },
};
const MERGED: (typeof MERGES)[string] = { ahead: 0, behind: 0, preview: { kind: 'up-to-date', conflicts: [] } };

export function createMockTransport(): Transport {
  const params = new URLSearchParams(location.search);
  const scenario = params.get('scenario') ?? 'default';
  const listeners = new Map<EventName, Set<(p: unknown) => void>>();
  const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  let opState: RepoOpState | null = scenario === 'conflict' ? makeConflictState() : null;
  let refs = makeRefs();
  if (scenario === 'detached') refs = { ...refs, head: { kind: 'detached', oid: oid(42) }, local: refs.local.map((b) => ({ ...b, isHead: false })) };
  if (scenario === 'folders') refs = withPrefixedRefs(refs);
  let stashes = scenario === 'empty' ? [] : makeStashes();
  let status = scenario === 'empty' ? makeStatus({ files: [], upstream: null, ahead: null, behind: null }) : makeStatus();
  if (scenario === 'conflict') status = { ...status, files: [conflictFile('src/lexer.ts', 'deleted-by-us'), conflictFile('src/parser.ts', 'both-modified'), ...status.files] };
  const recents = makeRecents();
  const sim = createDefaultDiffSim();
  const history = createHistorySim();
  let news = 0;
  let deletedTag: TagInfo | null = null;
  // Messages changed by "Edit message..." (oids do not change in the mock), and those to put back on undo (`null`: nothing to undo).
  let reworded = new Map<string, string>();
  let rewordedBefore: Map<string, string> | null = null;
  const subjectOf = (o: string, fallback: string): string => reworded.get(o)?.split('\n')[0] ?? fallback;
  const withRewords = (page: LogPage): LogPage => ({ ...page, rows: page.rows.map((r) => (reworded.has(r.oid) ? { ...r, summary: subjectOf(r.oid, r.summary) } : r)) });
  // Tags the mock remote has: `v0.2.0` is there under another commit (a push of it is refused until it is deleted there).
  const remoteTags = new Map<string, 'theirs' | 'ours'>([['v0.2.0', 'theirs']]);
  // The trash of discarded files, newest first. Contents are not simulated: a restore brings the file back as modified.
  let trash: DiscardedFile[] = [];
  let trashSeq = 0;
  const keep = (path: string, source: DiscardSource, size = 1200 + 37 * trashSeq): void => {
    trashSeq++;
    trash = [{ id: `mock-${trashSeq}`, path, oid: oid(5000 + trashSeq), kind: 'file', size, time: Math.floor(Date.now() / 1000), source }, ...trash];
  };
  const repoIds = new Map<string, number>();
  const initialized = new Set<string>(); // folders `repo_init` has turned into repositories

  const emit = <N extends EventName>(name: N, payload: EventMap[N]) => {
    for (const l of listeners.get(name) ?? []) l(payload);
    dispatchEvent(name, payload as never);
  };

  /** Applies a hunk (or some of its lines) to the simulated files, then shows the new state of their entries in the status. */
  const hunkOp = (op: SimOp, a: Record<string, unknown>) => {
    sim.apply(op, a as unknown as HunkRequest);
    if (op === 'discard') keep(String(a.path), 'discard-hunk');
    status = {
      ...status,
      files: status.files.flatMap((f) => {
        if (!sim.has(f.path) || f.conflict) return [f];
        const { staged, unstaged } = sim.flags(f.path);
        return staged || unstaged ? [{ ...f, staged: staged ? ('modified' as const) : null, unstaged: unstaged ? ('modified' as const) : null }] : [];
      }),
    };
    emit('repo:changed', { repoId: 1, kinds: ['index', 'worktree'] });
    return status;
  };

  /** Takes `paths` out of the conflicts (`deletes`: those whose file disappears) and tells the operation under way. */
  const settle = (paths: string[], deletes: (f: FileStatus) => boolean) => {
    status = {
      ...status,
      files: status.files.flatMap((f) => (f.conflict && paths.includes(f.path) ? (deletes(f) ? [] : [{ ...f, conflict: null, staged: 'modified' as const }]) : [f])),
    };
    if (opState) {
      opState = { ...opState, conflictedPaths: opState.conflictedPaths.filter((p) => !paths.includes(p)) };
      emit('op:state', { repoId: 1, state: opState });
    }
    emit('repo:changed', { repoId: 1, kinds: ['index', 'worktree'] });
    return status;
  };

  // Bulk staging ("Stage tracked" / "Stage all") and "Unstage all": conflicts, submodules and non-UTF-8 paths are left alone.
  const bulkWritable = (f: FileStatus): boolean => !f.conflict && f.submodule !== true && f.nonUtf8 !== true;
  const stageEverything = (scope: unknown) => {
    const hit = (f: FileStatus): boolean => bulkWritable(f) && !!f.unstaged && (scope !== 'tracked' || f.unstaged !== 'untracked');
    status = {
      ...status,
      files: status.files.map((f) =>
        hit(f) ? { ...f, staged: f.unstaged === 'untracked' || f.staged === 'added' ? ('added' as const) : f.unstaged, unstaged: null } : f),
    };
    emit('repo:changed', { repoId: 1, kinds: ['index'] });
    return status;
  };
  const unstageEverything = () => {
    const hit = (f: FileStatus): boolean => bulkWritable(f) && !!f.staged;
    status = {
      ...status,
      files: status.files.map((f) =>
        hit(f) ? { ...f, oldPath: null, staged: null, unstaged: f.staged === 'added' || f.staged === 'renamed' ? ('untracked' as const) : (f.unstaged ?? f.staged) } : f),
    };
    emit('repo:changed', { repoId: 1, kinds: ['index'] });
    return status;
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
      if (key === 'network.proxy.url' && typeof a.value === 'string' && !/^(https?|socks5h?):\/\/[^\s/?#]+\/?$/i.test(a.value)) {
        throw err('INVALID_ARGUMENT', 'Invalid proxy URL', { field: 'value' });
      }
      if (key === 'fetch.auto' && !FETCH_AUTO_CHOICES.includes(a.value as FetchAutoSetting)) {
        throw err('INVALID_ARGUMENT', 'Invalid fetch interval', { field: 'value' });
      }
      if (key === 'diff.contextLines' && !DIFF_CONTEXT_CHOICES.includes(a.value as DiffContextSetting)) {
        throw err('INVALID_ARGUMENT', 'Invalid number of context lines', { field: 'value' });
      }
      if (key === 'palette.recent' && !(Array.isArray(a.value) && a.value.length <= 20 && a.value.every((id) => typeof id === 'string' && id.length > 0))) {
        throw err('INVALID_ARGUMENT', 'Invalid list of commands', { field: 'value' });
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
      if (path.includes('existing')) throw err('ALREADY_EXISTS', `${path} is already a Git repository.`, { what: 'repo', path });
      initialized.add(path);
      return repoInfo(path);
    },
    repo_close: () => null,
    repo_activate: () => null,
    log_page: async (a) => {
      await sleep(40);
      return withRewords(makeLogPage(a.aroundOid ? 60 : 60, 60, 0, 60));
    },
    // Same rule as the backend for plain text: a sha prefix (4 characters or more) or a piece of the subject.
    log_search: async (a) => {
      await sleep(60);
      const q = String(a.query).trim().toLowerCase();
      const limit = Number(a.limit ?? 50);
      const hits = makeLogPage().rows.flatMap((r, row) =>
        q && (r.summary.toLowerCase().includes(q) || (q.length >= 4 && /^[0-9a-f]+$/.test(q) && r.oid.startsWith(q))) ? [{ oid: r.oid, row }] : []);
      return { matches: hits.slice(0, limit), truncated: hits.length > limit };
    },
    refs_list: () => refs,
    remote_list: () => makeRemotes(),
    // Merge dialog: how many commits each side has, then the dry run of the merge.
    branch_compare: (a): BranchCompare => {
      const m = MERGES[String(a.target)] ?? MERGED;
      return {
        branchOid: oid(60), targetOid: oid(41), mergeBase: oid(30), ahead: m.ahead, behind: m.behind,
        commits: [], merges: 0, pushed: 0, dirty: false, defaultMergeMessage: `Merge branch '${String(a.target)}' into main`,
      };
    },
    merge_preview: async (a): Promise<MergePreview> => {
      await sleep(400);
      const m = MERGES[String(a.ref)] ?? MERGED;
      return { ...m.preview, head: oid(60), target: oid(41), conflictTotal: m.preview.conflicts.length };
    },
    merge_branch: async (a) => {
      await sleep(400);
      const m = MERGES[String(a.ref)] ?? MERGED;
      return { result: m.behind === 0 ? 'up-to-date' : m.ahead === 0 ? 'fast-forward' : 'merged', oid: oid(61) };
    },
    stash_list: () => stashes,
    status_get: () => (scenario === 'degraded' ? { ...status, watcherDegraded: true } : status),
    undo_peek: () => (deletedTag ? tagDeleteUndo(deletedTag) : rewordedBefore ? rewordUndo() : makeUndo(scenario !== 'empty')),
    commit_details: (a) => ({
      oid: String(a.oid), parents: [oid(Number.parseInt(String(a.oid).slice(-2), 16) - 1)], tree: oid(7777),
      author: { name: 'Alice Martin', email: 'alice@example.org', time: 1790000000, offsetMinutes: 120 },
      committer: { name: 'Alice Martin', email: 'alice@example.org', time: 1790000000, offsetMinutes: 120 },
      message: reworded.get(String(a.oid)) ?? 'feat: login form\n\nAdds the login form and its validation.', files: history.filesOf(String(a.oid)), truncated: false,
    }),
    file_log: async (a) => {
      await sleep(80);
      return history.log({
        path: String(a.path), ...(typeof a.rev === 'string' ? { rev: a.rev } : {}), ...(typeof a.follow === 'boolean' ? { follow: a.follow } : {}),
        ...(typeof a.limit === 'number' ? { limit: a.limit } : {}), ...(typeof a.cursor === 'string' ? { cursor: a.cursor } : {}),
      });
    },
    file_blame: async (a) => {
      await sleep(120);
      return history.blame({ path: String(a.path), ...(typeof a.rev === 'string' ? { rev: a.rev } : {}) });
    },
    diff_file: (a) => {
      const source = a.source as { kind: string; oid?: string; view?: ConflictView };
      const kind = source.kind;
      if ((kind === 'unstaged' || kind === 'staged') && sim.has(String(a.path))) return sim.diff(String(a.path), kind, a.contextLines as number | undefined);
      if (kind === 'conflict' && status.files.some((f) => f.path === a.path && f.conflict)) {
        const d = conflictDiff(String(a.path), source.view ?? 'markers', a.contextLines as number | undefined);
        if (d) return d;
      }
      if (kind === 'commit' && source.oid !== undefined) {
        const d = history.diff(String(a.path), source.oid, a.contextLines as number | undefined);
        if (d) return d;
      }
      throw err('GIT_FAILED', `Mock: the diff of "${String(a.path)}" is not simulated`, { command: 'diff_file' });
    },
    stage_hunk: (a) => hunkOp('stage', a),
    unstage_hunk: (a) => hunkOp('unstage', a),
    discard_hunk: (a) => hunkOp('discard', a),
    // "Mark as resolved" stages a conflicted file as it is; staging other files one by one is not simulated.
    stage_paths: (a) =>
      a.paths === 'all'
        ? stageEverything('all')
        : Array.isArray(a.paths) && a.paths.some((p) => status.files.some((f) => f.path === p && f.conflict)) ? settle(a.paths as string[], () => false) : status,
    stage_all: (a) => stageEverything(a.scope),
    unstage_paths: (a) => (a.paths === 'all' ? unstageEverything() : status),
    // A discard keeps what it throws away (see `discard_list`); a file that is only staged has nothing to discard.
    discard_paths: (a) => {
      const all = a.paths === 'all';
      const wanted = (f: FileStatus): boolean => !f.conflict && f.unstaged !== null && (all || (a.paths as string[]).includes(f.path));
      for (const f of status.files.filter(wanted)) keep(f.path, 'discard');
      status = { ...status, files: status.files.flatMap((f) => (wanted(f) ? (f.staged ? [{ ...f, unstaged: null }] : []) : [f])) };
      emit('repo:changed', { repoId: 1, kinds: ['index', 'worktree'] });
      return status;
    },
    discard_list: () => trash,
    discard_restore: (a) => {
      const entries = (a.ids as string[]).map((id) => {
        const e = trash.find((x) => x.id === id);
        if (!e) throw err('NOT_FOUND', 'This discarded file is no longer available.', { what: 'discarded', id });
        return e;
      });
      const restored = entries.map((e) => e.path);
      status = {
        ...status,
        files: [
          ...status.files.map((f) => (restored.includes(f.path) ? { ...f, unstaged: 'modified' as const } : f)),
          ...restored
            .filter((p) => !status.files.some((f) => f.path === p))
            .map((path): FileStatus => ({ path, oldPath: null, staged: null, unstaged: 'modified', conflict: null, oldMode: null, newMode: null, submodule: null, nonUtf8: null })),
        ],
      };
      emit('repo:changed', { repoId: 1, kinds: ['worktree'] });
      return { restored, replaced: [], status };
    },
    // "Take ours / theirs": a kept file is staged, a file the chosen side deleted disappears; the operation loses the conflict.
    resolve_paths: (a) => {
      const paths = a.paths as string[];
      for (const f of status.files) if (f.conflict && paths.includes(f.path)) keep(f.path, 'resolve');
      return settle(paths, (f) =>
        (f.conflict === 'deleted-by-us' && a.side === 'ours') || (f.conflict === 'deleted-by-them' && a.side === 'theirs') || f.conflict === 'both-deleted');
    },
    remote_fetch: async (a) => {
      for (const p of [20, 55, 90]) {
        emit('op:progress', { opId: String(a.opId), label: 'Receiving objects', percent: p });
        await sleep(350);
      }
      // Background fetch (`fetch.auto` in Settings): upstream gets a new commit each time, to try the "Pull" toast.
      if (a.background === true) {
        news++;
        refs = withUpstreamNews(refs, news);
        status = { ...status, behind: (status.behind ?? 0) + 1 };
      }
      emit('repo:changed', { repoId: 1, kinds: ['refs'] });
      return null;
    },
    remote_pull: async () => {
      await sleep(600);
      refs = withUpstreamNews(refs, 0);
      status = { ...status, behind: 0 };
      emit('repo:changed', { repoId: 1, kinds: ['refs', 'head'] });
      return { head: { branch: 'main', oid: oid(61), detached: false, unborn: false } };
    },
    remote_push: async (a) => {
      await sleep(600);
      // `--follow-tags`: the annotated tags go with the branch (lightweight ones never do), but a tag the remote holds under
      // another commit is never overwritten.
      if (a.followTags === true) for (const tag of refs.tags) if (tag.annotated && !remoteTags.has(tag.name)) remoteTags.set(tag.name, 'ours');
      return null;
    },
    tag_create: (a) => {
      const name = String(a.name);
      if (name === '' || name.startsWith('-') || /[\s~^:?*[\\]|\.\.|\/\/|\.lock$|\.$/.test(name)) {
        throw err('INVALID_ARGUMENT', `Invalid tag name: "${name}".`, { field: 'name', reason: 'invalid-format' });
      }
      if (refs.tags.some((t) => t.name === name)) throw err('ALREADY_EXISTS', `The tag "${name}" already exists.`, { what: 'tag', name });
      const target = typeof a.target === 'string' ? a.target : oid(60);
      const annotated = typeof a.message === 'string' && a.message.trim() !== '';
      const tag: TagInfo = { name, fullRef: `refs/tags/${name}`, oid: annotated ? oid(3000 + refs.tags.length) : target, targetOid: target, annotated };
      refs = { ...refs, tags: [tag, ...refs.tags] };
      emit('repo:changed', { repoId: 1, kinds: ['refs'] });
      return refs;
    },
    tag_delete: (a) => {
      const tag = refs.tags.find((t) => t.name === a.name);
      if (!tag) throw err('NOT_FOUND', `The tag "${String(a.name)}" no longer exists.`, { what: 'ref', name: a.name });
      deletedTag = tag;
      rewordedBefore = null;
      refs = { ...refs, tags: refs.tags.filter((t) => t !== tag) };
      emit('repo:changed', { repoId: 1, kinds: ['refs'] });
      return { deletedOid: tag.oid, refs };
    },
    tag_push: async (a) => {
      for (const p of [30, 80]) {
        emit('op:progress', { opId: String(a.opId), label: 'Writing objects', percent: p });
        await sleep(250);
      }
      const name = String(a.name);
      if (a.delete === true) {
        if (!remoteTags.delete(name)) throw err('NOT_FOUND', `${String(a.remote)} has no tag named "${name}".`, { what: 'remote-tag', name, remote: a.remote });
        return null;
      }
      if (remoteTags.get(name) === 'theirs') {
        throw err('ALREADY_EXISTS', `${String(a.remote)} already has a different tag named "${name}".`, { what: 'remote-tag', name, remote: a.remote });
      }
      remoteTags.set(name, 'ours');
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
    rebase_todo_preview: (a) => {
      // `upstream..HEAD` of the linear mock log (HEAD = 60, origin/main = 58): oldest first.
      const from = a.upstream ? Number.parseInt(String(a.upstream), 16) + 1 : 1;
      const rows = makeLogPage(60, 60).rows.filter((r) => Number.parseInt(r.oid, 16) >= from).reverse();
      return {
        base: a.upstream ?? null, head: oid(60),
        items: rows.map((r) => ({
          oid: r.oid, shortOid: r.oid.slice(0, 7), summary: subjectOf(r.oid, r.summary), message: reworded.get(r.oid) ?? r.summary, author: 'Alice Martin',
          pushed: Number.parseInt(r.oid, 16) <= 58,
        })),
      };
    },
    // Only the `reword` lines are simulated (the history stays linear and keeps its oids).
    rebase_interactive_start: async (a) => {
      await sleep(600);
      const rewords = (a.todo as TodoItem[]).filter((i) => i.action === 'reword' && typeof i.message === 'string');
      if (rewords.length > 0) {
        rewordedBefore = new Map(reworded);
        deletedTag = null;
        reworded = new Map(reworded);
        for (const i of rewords) reworded.set(i.oid, i.message!.trim());
      }
      emit('repo:changed', { repoId: 1, kinds: ['head', 'refs'] });
      return { head: { branch: 'main', oid: oid(60), detached: false, unborn: false } };
    },
    rebase_abort: () => {
      opState = null;
      emit('op:state', { repoId: 1, state: null });
      return { head: { branch: 'main', oid: oid(60), detached: false, unborn: false } };
    },
    undo_last: () => {
      if (rewordedBefore) {
        reworded = rewordedBefore;
        rewordedBefore = null;
        emit('repo:changed', { repoId: 1, kinds: ['head', 'refs'] });
        return { head: { branch: 'main', oid: oid(60), detached: false, unborn: false } };
      }
      if (deletedTag) {
        refs = { ...refs, tags: [deletedTag, ...refs.tags] };
        deletedTag = null;
        emit('repo:changed', { repoId: 1, kinds: ['refs'] });
        return { head: { branch: 'main', oid: oid(60), detached: false, unborn: false } };
      }
      return { head: { branch: 'main', oid: oid(59), detached: false, unborn: false } };
    },
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
    advanceAutoFetch: (ms: number) => { autoFetch.advance(ms); },
    get state() {
      return { opState, refs, stashes, status };
    },
  };
  return transport;
}
