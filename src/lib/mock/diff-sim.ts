// A few files kept in memory for the mock transport (`?mock=1`, development only): enough git to try the diff viewer
// and line staging without a backend. A file has three versions (HEAD, index, worktree); `diff_file` compares two of
// them and `stage_hunk` / `unstage_hunk` / `discard_hunk` apply a whole hunk or some of its lines to the right one,
// with the same rule as the backend (`write/patch.rs`): what is not picked stays as the target file has it.
import type { AppError, DiffLine, FileDiff, Hunk } from '../ipc/types';

export interface Op extends DiffLine {
  kind: 'ctx' | 'add' | 'del';
}

const CONTEXT = 3;
const MAX_CONTEXT = 100;

/** The backend's rule for `contextLines`: absent is 3, otherwise 1 to 100. */
function contextOf(requested: number | undefined): number {
  if (requested === undefined) return CONTEXT;
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_CONTEXT) {
    throw fail('INVALID_ARGUMENT', `Context lines: a number from 1 to ${MAX_CONTEXT} is expected.`, { field: 'contextLines', reason: 'out-of-range' });
  }
  return requested;
}

/** Line-by-line edit script from `a` to `b` (LCS); inside a block of changes the removals come first, as in git. */
export function edit(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const ops: Op[] = [];
  let block: { del: Op[]; add: Op[] } = { del: [], add: [] };
  const flush = (): void => {
    ops.push(...block.del, ...block.add);
    block = { del: [], add: [] };
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      ops.push({ kind: 'ctx', text: a[i]!, oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      block.del.push({ kind: 'del', text: a[i]!, oldNo: i + 1, newNo: null });
      i++;
    } else {
      block.add.push({ kind: 'add', text: b[j]!, oldNo: null, newNo: j + 1 });
      j++;
    }
  }
  flush();
  return ops;
}

/** Hunks with `context` lines of context (three by default); changes closer than twice that share a hunk. */
export function hunksOf(a: readonly string[], b: readonly string[], context = CONTEXT): Hunk[] {
  const ops = edit(a, b);
  const ranges: [number, number][] = [];
  ops.forEach((op, k) => {
    if (op.kind === 'ctx') return;
    const from = Math.max(0, k - context);
    const to = Math.min(ops.length - 1, k + context);
    const last = ranges[ranges.length - 1];
    if (last && from <= last[1] + 1) last[1] = to;
    else ranges.push([from, to]);
  });
  return ranges.map(([from, to]) => {
    const lines = ops.slice(from, to + 1);
    const old = lines.filter((l) => l.kind !== 'add');
    const now = lines.filter((l) => l.kind !== 'del');
    const oldStart = old[0]?.oldNo ?? 0;
    const newStart = now[0]?.newNo ?? 0;
    return {
      header: `@@ -${oldStart},${old.length} +${newStart},${now.length} @@`,
      oldStart, oldLines: old.length, newStart, newLines: now.length, lines,
    };
  });
}

function hashOf(hunks: readonly Hunk[]): string {
  let h = 0x811c9dc5;
  for (const c of JSON.stringify(hunks)) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

export function fileDiffOf(path: string, a: readonly string[], b: readonly string[], context = CONTEXT): FileDiff {
  const hunks = hunksOf(a, b, context);
  const count = (kind: DiffLine['kind']): number => hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === kind).length, 0);
  return {
    path, oldPath: null, oldMode: null, newMode: null, binary: false, lossy: false, tooLarge: null, oldSize: null, newSize: null,
    hunks, stats: { added: count('add'), removed: count('del') }, hash: hashOf(hunks), submodule: null, lfsPointer: null,
  };
}

/**
 * `target` with hunk `hunk` acted on. `forward`: staging, `target` is the old side. Otherwise the target is the new side
 * (unstaging, discarding) and the picked changes are reverted. `picked` null: every change of the hunk.
 */
export function applyHunk(target: readonly string[], hunk: Hunk, picked: ReadonlySet<number> | null, forward: boolean): string[] {
  const [start, count] = forward ? [hunk.oldStart, hunk.oldLines] : [hunk.newStart, hunk.newLines];
  const from = count === 0 ? start : start - 1;
  const kept = hunk.lines.flatMap((l, i) => {
    const pick = picked === null || picked.has(i);
    const keep = l.kind === 'ctx' || (forward ? (l.kind === 'add') === pick : (l.kind === 'del') === pick);
    return keep ? [l.text] : [];
  });
  return [...target.slice(0, from), ...kept, ...target.slice(from + count)];
}

const fail = (code: AppError['code'], message: string, details: Record<string, unknown>): AppError => ({ code, message, details });

export interface HunkRequest {
  path: string;
  diffHash: string;
  hunkIndex: number;
  lines?: number[];
  contextLines?: number;
}

const split = (text: string): string[] => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));

export type SimOp = 'stage' | 'unstage' | 'discard';

export function createDiffSim(files: Record<string, { head: string; index: string; work: string }>) {
  const state = new Map(Object.entries(files).map(([path, f]) => [path, { head: split(f.head), index: split(f.index), work: split(f.work) }]));
  const get = (path: string) => {
    const f = state.get(path);
    if (!f) throw fail('NOT_FOUND', `Mock: ${path} is not simulated`, { what: 'path', path });
    return f;
  };
  const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((l, i) => l === b[i]);

  return {
    has: (path: string): boolean => state.has(path),
    paths: (): string[] => [...state.keys()],
    /** `staged`: HEAD against the index; otherwise the index against the worktree. `contextLines`: as the backend takes it. */
    diff(path: string, kind: 'staged' | 'unstaged', contextLines?: number): FileDiff {
      const f = get(path);
      const context = contextOf(contextLines);
      return kind === 'staged' ? fileDiffOf(path, f.head, f.index, context) : fileDiffOf(path, f.index, f.work, context);
    },
    /** What the status shows for the file. */
    flags(path: string): { staged: boolean; unstaged: boolean } {
      const f = get(path);
      return { staged: !same(f.head, f.index), unstaged: !same(f.index, f.work) };
    },
    apply(op: SimOp, req: HunkRequest): void {
      const f = get(req.path);
      const d = this.diff(req.path, op === 'unstage' ? 'staged' : 'unstaged', req.contextLines);
      if (d.hash !== req.diffHash) throw fail('STALE', 'Expired data: recharge.', { what: 'diff' });
      const hunk = d.hunks[req.hunkIndex];
      if (!hunk) throw fail('INVALID_ARGUMENT', 'This hunk does not exist.', { field: 'hunkIndex', reason: 'out-of-range' });
      let picked: Set<number> | null = null;
      if (req.lines) {
        const changes = hunk.lines.flatMap((l, i) => (l.kind === 'ctx' ? [] : [i]));
        if (req.lines.length === 0) throw fail('INVALID_ARGUMENT', 'Select at least one changed line.', { field: 'lines', reason: 'empty-selection' });
        const bad = req.lines.find((i) => !changes.includes(i));
        if (bad !== undefined) throw fail('INVALID_ARGUMENT', 'Only added or removed lines can be selected.', { field: 'lines', reason: 'bad-line', line: bad });
        picked = new Set(req.lines);
      }
      if (op === 'stage') f.index = applyHunk(f.index, hunk, picked, true);
      else if (op === 'unstage') f.index = applyHunk(f.index, hunk, picked, false);
      else f.work = applyHunk(f.work, hunk, picked, false);
    },
  };
}

export type DiffSim = ReturnType<typeof createDiffSim>;

const APP = `<script lang="ts">
  import Header from './Header.svelte';
  import { greeting } from './greeting';

  let name = $state('world');
  let count = $state(0);

  function increment() {
    count += 1;
  }

  function reset() {
    count = 0;
  }
</script>

<Header />
<h1>{greeting(name)}</h1>
<button onclick={increment}>Clicked {count} times</button>
<button onclick={reset}>Reset</button>
<input bind:value={name} />
`;

const APP_WORK = APP
  .replace("let name = $state('world');", "let name = $state('Alice');")
  .replace('  let count = $state(0);\n', '  let count = $state(0);\n  let step = $state(2);\n')
  .replace('count += 1;', 'count += step;')
  .replace('<button onclick={reset}>Reset</button>', '<button onclick={reset} disabled={count === 0}>Reset</button>')
  .replace('<input bind:value={name} />', '<input bind:value={name} placeholder="Your name" />');

const README = '# Demo\n\nA small demo repository.\n\n## Usage\n\nRun `pnpm dev`.\n';

/** The committed text of the two simulated files (what `history-sim.ts` ends its histories with). */
export const COMMITTED = { 'src/App.svelte': APP, 'README.md': README } as const;

/** The files of the default mock repository that have a diff: `src/App.svelte` (unstaged) and `README.md` (staged). */
export function createDefaultDiffSim(): DiffSim {
  return createDiffSim({
    'src/App.svelte': { head: APP, index: APP, work: APP_WORK },
    'README.md': { head: README, index: `${README}\nSee the docs for more.\n`, work: `${README}\nSee the docs for more.\n` },
  });
}
