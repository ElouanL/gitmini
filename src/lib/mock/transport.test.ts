import { describe, expect, it } from 'vitest';
import type { CommitDetails, DiscardedFile, LogPage, RefsSnapshot, RepoOpState, TodoPreview, UndoStatus, FileDiff, StatusSnapshot } from '../ipc/types';
import type { DiscardRestoreResult } from '../ipc/commands';
import { oid } from '../test/fixtures';
import { createMockTransport } from './transport';

describe('mock transport: diffs and line staging', () => {
  const transport = createMockTransport();
  const call = <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => transport.invoke(command, { repoId: 1, ...args }) as Promise<T>;
  const entry = (s: StatusSnapshot, path: string) => s.files.find((f) => f.path === path);

  it("stages some lines of src/App.svelte, then unstages them, and the status follows", async () => {
    const d = await call<FileDiff>('diff_file', { path: 'src/App.svelte', source: { kind: 'unstaged' } });
    const lines = d.hunks[0]!.lines;
    const pick = [lines.findIndex((l) => l.kind === 'del'), lines.findIndex((l) => l.kind === 'add')];
    const staged = await call<StatusSnapshot>('stage_hunk', { path: 'src/App.svelte', diffHash: d.hash, hunkIndex: 0, lines: pick });
    expect(entry(staged, 'src/App.svelte')).toMatchObject({ staged: 'modified', unstaged: 'modified' });
    expect((await call<StatusSnapshot>('status_get')).files.map((f) => f.path)).toContain('src/App.svelte');

    const s = await call<FileDiff>('diff_file', { path: 'src/App.svelte', source: { kind: 'staged' } });
    expect(s.stats).toEqual({ added: 1, removed: 1 });
    const back = await call<StatusSnapshot>('unstage_hunk', { path: 'src/App.svelte', diffHash: s.hash, hunkIndex: 0 });
    expect(entry(back, 'src/App.svelte')).toMatchObject({ staged: null, unstaged: 'modified' });
  });

  it("an expired diff is refused and files without a simulated diff say so", async () => {
    await expect(call('stage_hunk', { path: 'src/App.svelte', diffHash: 'stale', hunkIndex: 0 })).rejects.toMatchObject({ code: 'STALE' });
    await expect(call('diff_file', { path: 'notes.txt', source: { kind: 'unstaged' } })).rejects.toMatchObject({ code: 'GIT_FAILED' });
  });

  it("discarding every change of a file removes it from the status", async () => {
    const d = await call<FileDiff>('diff_file', { path: 'README.md', source: { kind: 'staged' } });
    const out = await call<StatusSnapshot>('unstage_hunk', { path: 'README.md', diffHash: d.hash, hunkIndex: 0 });
    expect(entry(out, 'README.md')).toMatchObject({ staged: null, unstaged: 'modified' });
    const w = await call<FileDiff>('diff_file', { path: 'README.md', source: { kind: 'unstaged' } });
    const gone = await call<StatusSnapshot>('discard_hunk', { path: 'README.md', diffHash: w.hash, hunkIndex: 0 });
    expect(entry(gone, 'README.md')).toBeUndefined();
  });
});

describe('mock transport: diff context', () => {
  const transport = createMockTransport();
  const call = <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => transport.invoke(command, { repoId: 1, ...args }) as Promise<T>;

  it("diff_file honours contextLines: wider context, more lines", async () => {
    const narrow = await call<FileDiff>('diff_file', { path: 'src/App.svelte', source: { kind: 'unstaged' }, contextLines: 1 });
    const wide = await call<FileDiff>('diff_file', { path: 'src/App.svelte', source: { kind: 'unstaged' }, contextLines: 10 });
    const count = (d: FileDiff): number => d.hunks.reduce((n, h) => n + h.lines.length, 0);
    expect(count(wide)).toBeGreaterThan(count(narrow));
    expect(narrow.hash).not.toBe(wide.hash);
    await expect(call('diff_file', { path: 'src/App.svelte', source: { kind: 'unstaged' }, contextLines: 0 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it("stages a hunk read with another context", async () => {
    const d = await call<FileDiff>('diff_file', { path: 'src/App.svelte', source: { kind: 'unstaged' }, contextLines: 10 });
    await call('stage_hunk', { path: 'src/App.svelte', diffHash: d.hash, hunkIndex: 0, contextLines: 10 });
    const s = await call<FileDiff>('diff_file', { path: 'src/App.svelte', source: { kind: 'staged' }, contextLines: 10 });
    expect(s.stats.added).toBeGreaterThan(0);
  });

  it("settings_set takes the sizes the Settings dialog offers and nothing else", async () => {
    for (const n of [1, 3, 5, 10, 25]) await expect(call('settings_set', { key: 'diff.contextLines', value: n })).resolves.toBeNull();
    for (const bad of [0, 2, 26, '3', null]) await expect(call('settings_set', { key: 'diff.contextLines', value: bad })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', details: { field: 'value' } });
  });
});

describe('mock transport: palette', () => {
  const transport = createMockTransport();
  const call = <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => transport.invoke(command, { repoId: 1, ...args }) as Promise<T>;

  it("log_search finds a commit by a piece of its subject or by its sha, within the limit", async () => {
    const byText = await call<{ matches: { oid: string; row: number }[]; truncated: boolean }>('log_search', { query: 'LOGIN', limit: 50 });
    expect(byText.matches.length).toBeGreaterThan(0);
    expect(byText.truncated).toBe(false);
    expect(byText.matches[0]).toEqual({ oid: '0'.repeat(38) + '3c', row: 0 }); // newest first
    const limited = await call<{ matches: unknown[]; truncated: boolean }>('log_search', { query: 'feat', limit: 2 });
    expect(limited.matches).toHaveLength(2);
    expect(limited.truncated).toBe(true);
    const bySha = await call<{ matches: { oid: string }[] }>('log_search', { query: '0'.repeat(38) + '3b' });
    expect(bySha.matches.map((m) => m.oid)).toEqual(['0'.repeat(38) + '3b']);
    expect((await call<{ matches: unknown[] }>('log_search', { query: 'zzz-nothing' })).matches).toEqual([]);
    expect((await call<{ matches: unknown[] }>('log_search', { query: '   ' })).matches).toEqual([]);
  });

  it("settings_set keeps a list of command ids for palette.recent and nothing else", async () => {
    await expect(call('settings_set', { key: 'palette.recent', value: ['git.fetch', 'theme.toggle'] })).resolves.toBeNull();
    await expect(call('settings_set', { key: 'palette.recent', value: [] })).resolves.toBeNull();
    for (const bad of ['git.fetch', [''], [1], null, Array.from({ length: 21 }, (_, i) => `c${i}`)]) {
      await expect(call('settings_set', { key: 'palette.recent', value: bad })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', details: { field: 'value' } });
    }
  });
});

describe('mock transport: tags', () => {
  const transport = createMockTransport();
  const call = <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => transport.invoke(command, { repoId: 1, ...args }) as Promise<T>;
  const names = (r: RefsSnapshot): string[] => r.tags.map((t) => t.name);

  it('creates lightweight and annotated tags and refuses a name that is taken or malformed', async () => {
    const light = await call<RefsSnapshot>('tag_create', { name: 'v1.0.0', target: null, message: null });
    expect(light.tags[0]).toMatchObject({ name: 'v1.0.0', annotated: false });
    expect(light.tags[0]!.oid).toBe(light.tags[0]!.targetOid);
    const note = await call<RefsSnapshot>('tag_create', { name: 'v1.0.1', message: 'Fix' });
    expect(note.tags[0]).toMatchObject({ name: 'v1.0.1', annotated: true });
    expect(note.tags[0]!.oid).not.toBe(note.tags[0]!.targetOid);
    await expect(call('tag_create', { name: 'v1.0.0' })).rejects.toMatchObject({ code: 'ALREADY_EXISTS', details: { what: 'tag' } });
    for (const bad of ['', '-x', 'a b', 'a..b', 'x.lock']) await expect(call('tag_create', { name: bad })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', details: { field: 'name' } });
  });

  it('deleting offers the undo of that tag, which puts it back', async () => {
    const out = await call<{ deletedOid: string; refs: RefsSnapshot }>('tag_delete', { name: 'v0.1.0' });
    expect(names(out.refs)).not.toContain('v0.1.0');
    const peek = await call<UndoStatus>('undo_peek');
    expect(peek.entry).toMatchObject({ kind: 'tag-delete', refName: 'refs/tags/v0.1.0' });
    await call('undo_last', { entryId: peek.entry!.id });
    expect(names(await call<RefsSnapshot>('refs_list'))).toContain('v0.1.0');
    await expect(call('tag_delete', { name: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND', details: { what: 'ref' } });
  });

  it('push succeeds, except for the tag the remote is pretended to hold already', async () => {
    await expect(call('tag_push', { opId: 'x', remote: 'origin', name: 'v0.1.0' })).resolves.toBeNull();
    await expect(call('tag_push', { opId: 'x', remote: 'origin', name: 'v0.2.0' })).rejects.toMatchObject({ code: 'ALREADY_EXISTS', details: { what: 'remote-tag' } });
  });

  it('push with delete removes the tag from the remote once, then reports that the remote lacks it', async () => {
    await expect(call('tag_push', { opId: 'x', remote: 'origin', name: 'v0.2.0', delete: true })).resolves.toBeNull();
    await expect(call('tag_push', { opId: 'x', remote: 'origin', name: 'v0.2.0', delete: true })).rejects.toMatchObject({ code: 'NOT_FOUND', details: { what: 'remote-tag', remote: 'origin' } });
    // nothing local moves, and the name is free to be pushed now
    expect(names(await call<RefsSnapshot>('refs_list'))).toContain('v0.2.0');
    await expect(call('tag_push', { opId: 'x', remote: 'origin', name: 'v0.2.0' })).resolves.toBeNull();
  });
});

describe('mock transport: push with followTags', () => {
  it('sends the annotated tags with the branch, and only when asked to', async () => {
    const transport = createMockTransport();
    const call = <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => transport.invoke(command, { repoId: 1, ...args }) as Promise<T>;
    await call('tag_create', { name: 'f-annotated', message: 'Fix' });
    await call('tag_create', { name: 'f-light' });
    const push = (followTags?: boolean) => call('remote_push', { opId: 'x', remote: 'origin', branch: 'main', setUpstream: false, forceWithLease: false, ...(followTags === undefined ? {} : { followTags }) });
    const remoteHas = (name: string) => call('tag_push', { opId: 'x', remote: 'origin', name, delete: true }).then(() => true, () => false);

    await push();
    await push(false);
    // The remote lacks both: deleting there says so (and changes nothing, the check is repeatable).
    await expect(call('tag_push', { opId: 'x', remote: 'origin', name: 'f-annotated', delete: true })).rejects.toMatchObject({ code: 'NOT_FOUND', details: { what: 'remote-tag' } });

    await push(true);
    expect(await remoteHas('f-light')).toBe(false);
    expect(await remoteHas('f-annotated')).toBe(true);
    // A tag the remote holds under another commit stays theirs, annotated or not.
    await push(true);
    await expect(call('tag_push', { opId: 'x', remote: 'origin', name: 'v0.2.0' })).rejects.toMatchObject({ code: 'ALREADY_EXISTS', details: { what: 'remote-tag' } });
  });
});

describe('mock transport: discarded files', () => {
  const transport = createMockTransport();
  const call = <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => transport.invoke(command, { repoId: 1, ...args }) as Promise<T>;
  const paths = (list: DiscardedFile[]): string[] => list.map((e) => e.path);

  it('keeps a discarded file, a discarded hunk and a resolved conflict, newest first, and restores them', async () => {
    expect(await call<DiscardedFile[]>('discard_list')).toEqual([]);
    const gone = await call<StatusSnapshot>('discard_paths', { paths: ['notes.txt'] });
    expect(gone.files.map((f) => f.path)).not.toContain('notes.txt');
    const d = await call<FileDiff>('diff_file', { path: 'src/App.svelte', source: { kind: 'unstaged' } });
    await call('discard_hunk', { path: 'src/App.svelte', diffHash: d.hash, hunkIndex: 0 });

    const list = await call<DiscardedFile[]>('discard_list');
    expect(paths(list)).toEqual(['src/App.svelte', 'notes.txt']);
    expect(list.map((e) => e.source)).toEqual(['discard-hunk', 'discard']);
    expect(new Set(list.map((e) => e.id)).size).toBe(2);

    const back = await call<DiscardRestoreResult>('discard_restore', { ids: [list[1]!.id] });
    expect(back.restored).toEqual(['notes.txt']);
    expect(back.replaced).toEqual([]);
    expect(back.status.files.find((f) => f.path === 'notes.txt')).toMatchObject({ unstaged: 'modified' });
    await expect(call('discard_restore', { ids: ['nope'] })).rejects.toMatchObject({ code: 'NOT_FOUND', details: { what: 'discarded' } });
  });

  it('discarding everything keeps every unstaged file; a staged-only file is left alone', async () => {
    const t = createMockTransport();
    const c = <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => t.invoke(command, { repoId: 1, ...args }) as Promise<T>;
    const after = await c<StatusSnapshot>('discard_paths', { paths: 'all' });
    expect(after.files.map((f) => f.path)).toEqual(['README.md']);
    expect(paths(await c<DiscardedFile[]>('discard_list')).sort()).toEqual(['notes.txt', 'src/App.svelte']);
  });

  it('"Stage tracked" leaves untracked files; "Stage all" and "Unstage all" move every writable file', async () => {
    const t = createMockTransport();
    const c = <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => t.invoke(command, { repoId: 1, ...args }) as Promise<T>;
    const unstagedOf = (s: StatusSnapshot) => s.files.filter((f) => f.unstaged).map((f) => f.path).sort();
    const before = await c<StatusSnapshot>('status_get');
    const untracked = before.files.filter((f) => f.unstaged === 'untracked').map((f) => f.path).sort();
    expect(untracked.length).toBeGreaterThan(0);
    expect(unstagedOf(await c<StatusSnapshot>('stage_all', { scope: 'tracked' }))).toEqual(untracked);
    expect(unstagedOf(await c<StatusSnapshot>('stage_all', { scope: 'all' }))).toEqual([]);
    const after = await c<StatusSnapshot>('unstage_paths', { paths: 'all' });
    expect(after.files.filter((f) => f.staged)).toEqual([]);
  });
});

describe('mock transport: conflict scenario', () => {
  const inScenario = (name: string) => {
    window.history.replaceState(null, '', `/?mock=1&scenario=${name}`);
    try {
      return createMockTransport();
    } finally {
      window.history.replaceState(null, '', '/');
    }
  };
  const transport = inScenario('conflict');
  const call = <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => transport.invoke(command, { repoId: 1, ...args }) as Promise<T>;
  const conflicted = (s: StatusSnapshot): string[] => s.files.filter((f) => f.conflict).map((f) => f.path);
  const opStates: RepoOpState[] = [];
  void transport.listen('op:state', (p) => opStates.push((p as { state: RepoOpState }).state));

  it('shows the conflict of src/parser.ts as markers, then each side against the worktree', async () => {
    const markers = await call<FileDiff>('diff_file', { path: 'src/parser.ts', source: { kind: 'conflict', view: 'markers' } });
    expect(markers.hunks[0]!.lines.filter((l) => /^(<{7}|={7}|>{7})/.test(l.text))).toHaveLength(3);
    expect(markers.stats.removed).toBe(0);
    const ours = await call<FileDiff>('diff_file', { path: 'src/parser.ts', source: { kind: 'conflict', view: 'ours' } });
    expect(ours.stats.added).toBeGreaterThan(0);
    const theirs = await call<FileDiff>('diff_file', { path: 'src/lexer.ts', source: { kind: 'conflict', view: 'theirs' } });
    expect(theirs.hunks).toEqual([]); // deleted by us: the worktree holds their version, so there is nothing to compare
  });

  it('"Mark as resolved" stages the file and tells the rebase; the other conflict stays', async () => {
    const out = await call<StatusSnapshot>('stage_paths', { paths: ['src/parser.ts'] });
    expect(conflicted(out)).toEqual(['src/lexer.ts']);
    expect(out.files.find((f) => f.path === 'src/parser.ts')).toMatchObject({ conflict: null, staged: 'modified' });
    expect(opStates.at(-1)?.conflictedPaths).toEqual(['src/lexer.ts']);
    await expect(call('diff_file', { path: 'src/parser.ts', source: { kind: 'conflict', view: 'markers' } })).rejects.toMatchObject({ code: 'GIT_FAILED' });
  });

  it('taking the side that deleted a file removes it, and no conflict is left for the rebase', async () => {
    const out = await call<StatusSnapshot>('resolve_paths', { paths: ['src/lexer.ts'], side: 'ours' });
    expect(out.files.some((f) => f.path === 'src/lexer.ts')).toBe(false);
    expect(conflicted(out)).toEqual([]);
    expect(opStates.at(-1)?.conflictedPaths).toEqual([]);
  });
});

describe('mock transport: edit a commit message (reword)', () => {
  const transport = createMockTransport();
  const call = <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => transport.invoke(command, { repoId: 1, ...args }) as Promise<T>;
  const summaryOf = async (o: string) => (await call<LogPage>('log_page', { cursor: null })).rows.find((r) => r.oid === o)?.summary;

  it('a reword shows the new message in the graph, the details and the preview; the undo puts the old one back', async () => {
    const target = oid(59);
    const preview = await call<TodoPreview>('rebase_todo_preview', { upstream: oid(58) });
    expect(preview.items.map((i) => i.oid)).toEqual([oid(59), oid(60)]);
    const before = await summaryOf(target);
    await call('rebase_interactive_start', {
      opId: 'x', upstream: preview.base, expectedHead: preview.head, autostash: false,
      todo: preview.items.map((i) => (i.oid === target ? { oid: i.oid, action: 'reword', message: 'New title\n\nNew body' } : { oid: i.oid, action: 'pick' })),
    });
    expect(await summaryOf(target)).toBe('New title');
    expect((await call<CommitDetails>('commit_details', { oid: target })).message).toBe('New title\n\nNew body');
    expect((await call<TodoPreview>('rebase_todo_preview', { upstream: oid(58) })).items[0]).toMatchObject({ summary: 'New title', message: 'New title\n\nNew body' });
    const peek = await call<UndoStatus>('undo_peek');
    expect(peek.entry).toMatchObject({ kind: 'rebase' });
    await call('undo_last', { entryId: peek.entry!.id });
    expect(await summaryOf(target)).toBe(before);
    expect((await call<UndoStatus>('undo_peek')).entry?.kind).not.toBe('rebase');
  });
});
