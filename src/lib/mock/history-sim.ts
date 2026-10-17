// A few committed histories for the mock transport (`?mock=1`, development only): enough git to try the file history and the
// blame without a backend. `src/App.svelte` was added as `src/Main.svelte`, renamed and edited five times; `README.md` has three
// versions. The commits are those of the mock graph (`oid(n)`), so "Show in graph" lands on a real row. The last version of each
// file is the text `diff-sim.ts` starts its working-tree edits from.
import type { BlameCommit, BlameHunk, ChangeKind, FileBlame, FileChange, FileDiff, FileLogEntry, FileLogPage, Signature } from '../ipc/types';
import { COMMITTED, edit, fileDiffOf } from './diff-sim';
import { oid } from '../test/fixtures';

const NOW = Math.floor(Date.UTC(2026, 9, 2, 12, 0, 0) / 1000);
const PEOPLE = [
  { name: 'Alice Martin', email: 'alice@example.org' },
  { name: 'Bob Durand', email: 'bob@example.org' },
] as const;

/** One commit of a file's history: the file as it is in it. */
interface Version {
  /** Commit number: the commit is `oid(n)`. */
  n: number;
  summary: string;
  author: 0 | 1;
  /** The file's name in that commit. */
  path: string;
  lines: string[];
}

const split = (text: string): string[] => text.replace(/\n$/, '').split('\n');

function appVersions(): Version[] {
  const v5 = split(COMMITTED['src/App.svelte']);
  const v4 = v5.filter((l) => l !== '<input bind:value={name} />');
  const v3 = split(`<script lang="ts">
  import Header from './Header.svelte';
  import { greeting } from './greeting';

  let name = $state('world');
  let count = $state(0);

  function increment() {
    count += 1;
  }
</script>

<Header />
<h1>{greeting(name)}</h1>
<button onclick={increment}>Clicked {count} times</button>
`);
  const v2 = split(`<script lang="ts">
  import Header from './Header.svelte';

  let name = $state('world');
  let count = $state(0);
</script>

<Header />
<h1>Hello {name}</h1>
<button onclick={() => count++}>Clicked {count} times</button>
`);
  const v1 = split(`<script lang="ts">
  let name = $state('world');
  let count = $state(0);
</script>

<h1>Hello {name}</h1>
<button onclick={() => count++}>Clicked {count} times</button>
`);
  const v0 = split(`<script lang="ts">
  let count = $state(0);
</script>

<button onclick={() => count++}>Clicked {count} times</button>
`);
  return [
    { n: 12, summary: 'feat: counter button', author: 0, path: 'src/Main.svelte', lines: v0 },
    { n: 18, summary: 'feat: greet the user', author: 1, path: 'src/Main.svelte', lines: v1 },
    { n: 24, summary: 'refactor: rename Main to App and add the header', author: 0, path: 'src/App.svelte', lines: v2 },
    { n: 37, summary: 'refactor: extract increment, add greeting', author: 1, path: 'src/App.svelte', lines: v3 },
    { n: 44, summary: 'feat: reset button', author: 0, path: 'src/App.svelte', lines: v4 },
    { n: 52, summary: 'feat: edit the name', author: 1, path: 'src/App.svelte', lines: v5 },
  ];
}

function readmeVersions(): Version[] {
  const last = split(COMMITTED['README.md']);
  return [
    { n: 5, summary: 'docs: add a readme', author: 0, path: 'README.md', lines: ['# Demo', '', 'A demo repository.'] },
    { n: 31, summary: 'docs: explain how to run it', author: 1, path: 'README.md', lines: ['# Demo', '', 'A demo repository.', '', '## Usage', '', 'Run pnpm dev.'] },
    { n: 48, summary: 'docs: fix the wording', author: 0, path: 'README.md', lines: last },
  ];
}

const signature = (v: Version): Signature => ({ ...PEOPLE[v.author], time: NOW - (60 - v.n + 1) * 5400, offsetMinutes: 0 });

function countChanges(a: readonly string[], b: readonly string[]): { added: number; removed: number } {
  const ops = edit(a, b);
  return { added: ops.filter((o) => o.kind === 'add').length, removed: ops.filter((o) => o.kind === 'del').length };
}

const PAGE = 100;

export function createHistorySim() {
  const files: Version[][] = [appVersions(), readmeVersions()];
  const byCurrentPath = (path: string): Version[] | undefined => files.find((vs) => vs[vs.length - 1]!.path === path);

  /** Newest first, from the commit `rev` names (or the newest), optionally stopping where the file got its name. */
  function visible(versions: Version[], rev: string | undefined, follow: boolean): Version[] {
    const upTo = rev !== undefined && /^0*[0-9a-f]+$/.test(rev) && rev.length === 40 ? Number.parseInt(rev, 16) : Number.POSITIVE_INFINITY;
    let list = versions.filter((v) => v.n <= upTo);
    if (!follow) {
      const name = versions[versions.length - 1]!.path;
      const first = list.findIndex((v) => v.path === name);
      list = first < 0 ? [] : list.slice(first);
    }
    return list.reverse();
  }

  /** `follow` off: the commit that renamed the file is where it appears (added), as the backend lists it. */
  function entryOf(versions: Version[], v: Version, follow = true): FileLogEntry {
    const i = versions.indexOf(v);
    const prev = versions[i - 1];
    const moved = prev !== undefined && prev.path !== v.path;
    const renamed = moved && follow;
    const change: ChangeKind = prev === undefined || (moved && !follow) ? 'added' : renamed ? 'renamed' : 'modified';
    const counts = countChanges(moved && !follow ? [] : (prev?.lines ?? []), v.lines);
    const file: FileChange = {
      path: v.path, oldPath: renamed ? prev.path : null, change, additions: counts.added, deletions: counts.removed, binary: false, submodule: null,
    };
    return { oid: oid(v.n), parents: v.n > 1 ? [oid(v.n - 1)] : [], summary: v.summary, author: signature(v), file, parent: prev === undefined ? null : 1 };
  }

  return {
    /** Whether the history of `path` is simulated (under its current name). */
    has: (path: string): boolean => byCurrentPath(path) !== undefined,

    log(args: { path: string; rev?: string; follow?: boolean; limit?: number; cursor?: string }): FileLogPage {
      const versions = byCurrentPath(args.path);
      if (!versions) return { start: oid(60), entries: [], nextCursor: null };
      const list = visible(versions, args.cursor ? undefined : args.rev, args.follow ?? true);
      const from = args.cursor ? Number.parseInt(args.cursor, 10) : 0;
      const limit = args.limit ?? PAGE;
      const page = list.slice(from, from + limit);
      return {
        start: args.cursor ? null : oid(args.rev && args.rev.length === 40 ? Number.parseInt(args.rev, 16) : 60),
        entries: page.map((v) => entryOf(versions, v, args.follow ?? true)),
        nextCursor: from + limit < list.length ? String(from + limit) : null,
      };
    },

    /** The files a simulated commit changed, as `commit_details` lists them. */
    filesOf(commit: string): FileChange[] {
      const n = Number.parseInt(commit, 16);
      return files.flatMap((versions) => {
        const v = versions.find((x) => x.n === n);
        return v ? [entryOf(versions, v).file] : [];
      });
    },

    /** The diff a simulated commit made to `path`, `null` if it did not touch it. */
    diff(path: string, commit: string, context?: number): FileDiff | null {
      const versions = byCurrentPath(path);
      const n = Number.parseInt(commit, 16);
      const v = versions?.find((x) => x.n === n);
      if (!versions || !v) return null;
      const prev = versions[versions.indexOf(v) - 1];
      const d = fileDiffOf(v.path, prev?.lines ?? [], v.lines, context);
      return prev && prev.path !== v.path ? { ...d, oldPath: prev.path } : d;
    },

    /** The file as the commit `rev` has it, one run of lines per commit that wrote it (rename tracking included). */
    blame(args: { path: string; rev?: string }): FileBlame {
      const versions = byCurrentPath(args.path) ?? files.find((vs) => vs.some((v) => v.path === args.path));
      const missing = (): never => {
        throw { code: 'NOT_FOUND', message: `${args.path} does not exist in that commit.`, details: { what: 'path' } };
      };
      if (!versions) return missing();
      const upTo = args.rev && args.rev.length === 40 ? Number.parseInt(args.rev, 16) : Number.POSITIVE_INFINITY;
      const upTill = versions.filter((v) => v.n <= upTo);
      const at = upTill[upTill.length - 1];
      if (!at) return missing();
      // Who wrote each line: carry the origin of unchanged lines, give added lines to the commit that added them.
      let origin: { commit: Version; line: number }[] = [];
      let before: string[] = [];
      for (const v of upTill) {
        const ops = edit(before, v.lines);
        const next: { commit: Version; line: number }[] = [];
        for (const op of ops) {
          if (op.kind === 'ctx') next.push(origin[(op.oldNo ?? 1) - 1]!);
          else if (op.kind === 'add') next.push({ commit: v, line: op.newNo ?? 0 });
        }
        origin = next;
        before = v.lines;
      }
      const commits: BlameCommit[] = [];
      const indexOf = (v: Version): number => {
        let i = commits.findIndex((c) => c.oid === oid(v.n));
        if (i < 0) {
          i = commits.length;
          commits.push({ oid: oid(v.n), summary: v.summary, author: signature(v), root: v === versions[0] });
        }
        return i;
      };
      const hunks: BlameHunk[] = [];
      origin.forEach((o, i) => {
        const last = hunks[hunks.length - 1];
        if (last && last.commit === indexOf(o.commit) && last.origStart + last.lines === o.line) last.lines++;
        else hunks.push({ start: i + 1, lines: 1, commit: indexOf(o.commit), origStart: o.line, origPath: o.commit.path === at.path ? null : o.commit.path });
      });
      return { rev: oid(at.n), path: at.path, binary: false, tooLarge: null, lines: at.lines, hunks, commits };
    },
  };
}

export type HistorySim = ReturnType<typeof createHistorySim>;
