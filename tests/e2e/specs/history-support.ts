// Repository for the HIST / BLAME specs: the `linear` fixture plus a history that exercises the file history, written with a
// single `git fast-import` stream so that authors, dates and merges are exact.
// This file is not a spec (no `.e2e.ts` suffix): WDIO and check-traceability ignore it.
//
//   changelog.txt  130 commits by Alice, one line each (a history longer than a page of 100)
//   docs/guide.txt added by Alice, clarified by Bob, then moved to docs/manual.txt (one line changed with the move),
//                  extended by Carol, edited on a branch and on main at once (a merge that differs from both parents), tweaked
//   NOTES.md       added by Alice, deleted by Bob
//   src/unrelated.txt  a commit that touches none of the above
import type { PreparedFixture } from '../../support/fixture';
import { spawnGit } from '../../support/fixture';

export interface Person {
  name: string;
  email: string;
}
export const ALICE: Person = { name: 'Alice Dev', email: 'alice@example.org' };
export const BOB: Person = { name: 'Bob Dev', email: 'bob@example.org' };
export const CAROL: Person = { name: 'Carol Dev', email: 'carol@example.org' };

export const CHANGELOG_COMMITS = 130;

/** Summaries of the docs commits, oldest first, by the name used in the specs. */
export const SUMMARY = {
  guide: 'docs: add the guide',
  clarify: 'docs: clarify the intro',
  unrelated: 'src: unrelated change',
  move: 'docs: rename the guide to a manual',
  extend: 'docs: extend the manual',
  polish: 'docs: polish the title',
  closing: 'docs: fix the closing',
  merge: "Merge branch 'docs-polish'",
  tweak: 'docs: tweak step five',
  notes: 'notes: add NOTES.md',
  dropNotes: 'notes: drop NOTES.md',
} as const;

const guideLines = (edits: Record<number, string> = {}, extra: string[] = []): string =>
  `${[...Array.from({ length: 12 }, (_, i) => edits[i + 1] ?? `line ${i + 1} of the guide`), ...extra].join('\n')}\n`;

class Stream {
  private out: string[] = [];
  private mark = 0;
  private clock = 1_800_001_000;

  /** Appends a commit on `ref` and returns its mark. `files`: path → content (`null` deletes); `rename`: [from, to] first. */
  commit(
    ref: string,
    who: Person,
    message: string,
    opts: { from?: string; merge?: number; rename?: [string, string]; files?: Record<string, string | null>; time?: number } = {},
  ): number {
    const id = ++this.mark;
    this.clock = opts.time ?? this.clock + 60;
    const ident = `${who.name} <${who.email}> ${this.clock} +0000`;
    this.out.push(`commit refs/heads/${ref}`, `mark :${id}`, `author ${ident}`, `committer ${ident}`, `data ${Buffer.byteLength(message)}`, message);
    if (opts.from) this.out.push(`from ${opts.from}`);
    if (opts.merge !== undefined) this.out.push(`merge :${opts.merge}`);
    if (opts.rename) this.out.push(`R ${opts.rename[0]} ${opts.rename[1]}`);
    for (const [path, content] of Object.entries(opts.files ?? {})) {
      if (content === null) this.out.push(`D ${path}`);
      else this.out.push(`M 100644 inline ${path}`, `data ${Buffer.byteLength(content)}`, content);
    }
    this.out.push('');
    return id;
  }

  /** Moves the clock to `time` seconds (the next commit is a minute later). */
  at(time: number): this {
    this.clock = time;
    return this;
  }

  toString(): string {
    return `${this.out.join('\n')}\n`;
  }
}

/** Builds the history on top of the fixture and brings the worktree up to date; `main` stays the current branch. */
export function buildHistory(fx: PreparedFixture): void {
  const s = new Stream();
  // The changelog: 130 commits, from the fixture's tip.
  let log = '';
  for (let i = 1; i <= CHANGELOG_COMMITS; i++) {
    log += `entry ${i}\n`;
    s.commit('main', ALICE, `changelog: entry ${i}`, { ...(i === 1 ? { from: 'refs/heads/main^0' } : {}), files: { 'changelog.txt': log } });
  }
  s.at(1_800_200_000);
  const v1 = guideLines();
  const v2 = guideLines({ 3: 'line 3 of the guide (clarified)' });
  s.commit('main', ALICE, SUMMARY.guide, { files: { 'docs/guide.txt': v1 } });
  s.commit('main', BOB, SUMMARY.clarify, { files: { 'docs/guide.txt': v2 } });
  s.commit('main', ALICE, SUMMARY.unrelated, { files: { 'src/unrelated.txt': 'nothing to see\n' } });
  const v4 = guideLines({ 3: 'line 3 of the guide (clarified)', 8: 'line 8 of the manual' });
  s.commit('main', BOB, SUMMARY.move, { rename: ['docs/guide.txt', 'docs/manual.txt'], files: { 'docs/manual.txt': v4 } });
  const v5 = guideLines({ 3: 'line 3 of the guide (clarified)', 8: 'line 8 of the manual', 12: 'last line of the manual' }, ['appendix 1', 'appendix 2']);
  const extend = s.commit('main', CAROL, SUMMARY.extend, { files: { 'docs/manual.txt': v5 } });
  // A branch and main both edit the manual; their merge differs from each of them.
  const edits5 = { 3: 'line 3 of the guide (clarified)', 8: 'line 8 of the manual', 12: 'last line of the manual' };
  const polish = s.commit('docs-polish', ALICE, SUMMARY.polish, { from: `:${extend}`, files: { 'docs/manual.txt': guideLines({ ...edits5, 1: 'The Manual' }, ['appendix 1', 'appendix 2']) } });
  const closing = s.commit('main', BOB, SUMMARY.closing, { files: { 'docs/manual.txt': guideLines({ ...edits5, 10: 'line 10 closes the manual' }, ['appendix 1', 'appendix 2']) } });
  const mergedEdits = { ...edits5, 1: 'The Manual', 10: 'line 10 closes the manual' };
  s.commit('main', CAROL, SUMMARY.merge, { from: `:${closing}`, merge: polish, files: { 'docs/manual.txt': guideLines(mergedEdits, ['appendix 1', 'appendix 2']) } });
  s.commit('main', BOB, SUMMARY.tweak, { files: { 'docs/manual.txt': guideLines({ ...mergedEdits, 5: 'line 5 revised' }, ['appendix 1', 'appendix 2']) } });
  s.commit('main', ALICE, SUMMARY.notes, { files: { 'NOTES.md': 'remember the milk\n' } });
  s.commit('main', BOB, SUMMARY.dropNotes, { files: { 'NOTES.md': null } });

  const imported = spawnGit(fx.repo, ['fast-import', '--quiet'], { env: fx.env, input: s.toString() });
  if (imported.status !== 0) throw new Error(`git fast-import failed: ${imported.stderr}`);
  fx.git('reset', '-q', '--hard', 'main');
}

/** Oid of the commit with this summary on the current history (`git log --grep` is exact enough for these summaries). */
export function oidOf(fx: { git(...args: string[]): string }, summary: string): string {
  return fx.git('log', '--all', '--fixed-strings', `--grep=${summary}`, '--format=%H', '-n', '1');
}
