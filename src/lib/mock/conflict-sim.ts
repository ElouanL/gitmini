// The two files the `conflict` scenario leaves in conflict (`src/parser.ts` changed on both sides, `src/lexer.ts` deleted by us),
// with enough text for the conflict diff of the viewer: the worktree file as git leaves it (markers included) and each side's
// version compared with it, as `diff_file` answers for `{ kind: 'conflict', view }`.
import type { ConflictView, FileDiff } from '../ipc/types';
import { fileDiffOf } from './diff-sim';

interface ConflictFile {
  /** Stage 2 (the branch rebased onto, or HEAD); `null` when that side deleted the file. */
  ours: string | null;
  /** Stage 3; `null` when that side deleted the file. */
  theirs: string | null;
  /** What the worktree holds. */
  work: string;
}

const LEXER = `export interface Token {
  kind: 'word' | 'number' | 'punct';
  text: string;
}

export function lex(input: string): Token[] {
  return input.split(/\\s+/).filter(Boolean).map((text) => ({ kind: 'word', text }));
}
`;

const FILES: Record<string, ConflictFile> = {
  'src/parser.ts': {
    ours: `import { lex } from './lexer';

export function parse(input: string): Node[] {
  const tokens = lex(input, { strict: true });
  return tokens.map(toNode);
}
`,
    theirs: `import { lex } from './lexer';

export function parse(input: string): Node[] {
  const tokens = lex(input, { recover: true });
  return tokens.map(toNode);
}
`,
    work: `import { lex } from './lexer';

export function parse(input: string): Node[] {
<<<<<<< HEAD
  const tokens = lex(input, { strict: true });
=======
  const tokens = lex(input, { recover: true });
>>>>>>> 0000000 (Fix parser)
  return tokens.map(toNode);
}
`,
  },
  // Deleted by us: git leaves their version in the worktree, with no markers.
  'src/lexer.ts': { ours: null, theirs: LEXER, work: LEXER },
};

const lines = (text: string | null): string[] => (text === null ? [] : text.replace(/\n$/, '').split('\n'));

/** The conflict diff of `path` in `view`, or `null` when the file is not one of the simulated conflicts. */
export function conflictDiff(path: string, view: ConflictView, context?: number): FileDiff | null {
  const f = FILES[path];
  if (!f) return null;
  const old = view === 'markers' ? [] : lines(view === 'ours' ? f.ours : f.theirs);
  return fileDiffOf(path, old, lines(f.work), context);
}
