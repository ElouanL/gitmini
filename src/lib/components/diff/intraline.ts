// Intra-line highlighting (DIFF-05): inside a removed line and the added line that replaces it, which characters really
// changed. A token-level LCS (words, runs of whitespace, single punctuation marks), no dependency. Pure, tested.
//
// Three steps, each cheap on the lines of real code:
//   1. `markPair`   two lines to the changed character ranges of each, and how alike they are;
//   2. `findBlocks` which removed lines face which added lines (a "block": removals followed by additions);
//   3. `markBlock`  which removed line pairs with which added line (equal sizes: line by line; otherwise the alignment
//                   that maximizes similarity), so a line that has no counterpart stays unmarked.
// Offsets are UTF-16 code units of the text shown, so a range slices that text directly.

/** Changed characters of a line, `[start, end)`; sorted, not touching. */
export type Range = readonly [start: number, end: number];

/** Lines less alike than this (0 to 1) are different lines, not an edit: marking nearly all of them would be noise. */
export const MIN_SIMILARITY = 0.4;
/** Token pairs (after the common start and end are set aside) the LCS may fill; beyond, the whole middle counts as changed. */
export const MAX_LCS_CELLS = 40_000;
/** Removed × added lines of a block compared against each other; beyond, only equal-sized blocks pair, line by line. */
export const MAX_BLOCK_PAIRS = 400;
/** A word edited in place (`price` → `prices`) is cut down to the letters that differ when this share of it is kept. */
const WORD_REFINE_SHARE = 0.6;

const TOKEN_RE = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;
const WORD_RE = /^[\p{L}\p{N}_]+$/u;
const SPACE_RE = /^\s+$/u;

/** Words, runs of whitespace and single punctuation marks, in order; their texts concatenate back to `text`. */
export function tokenize(text: string): string[] {
  return text.match(TOKEN_RE) ?? [];
}

export interface PairMarks {
  /** Changed ranges of the old (removed) line. */
  old: Range[];
  /** Changed ranges of the new (added) line. */
  new: Range[];
  /** 0 to 1: share of the non-blank characters both lines keep. */
  similarity: number;
}

interface Region {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

/** Offsets of each token's start, plus the total length at the end. */
function offsets(tokens: readonly string[]): number[] {
  const out = new Array<number>(tokens.length + 1);
  let at = 0;
  tokens.forEach((t, i) => {
    out[i] = at;
    at += t.length;
  });
  out[tokens.length] = at;
  return out;
}

/** Characters of the non-blank tokens. */
function weight(tokens: readonly string[], from = 0, to = tokens.length): number {
  let n = 0;
  for (let i = from; i < to; i++) if (!SPACE_RE.test(tokens[i]!)) n += tokens[i]!.length;
  return n;
}

/**
 * Where `a` and `b` differ, as regions of tokens, with the weight of what they keep in common. Equal heads and tails are
 * set aside first (an edit is usually one spot in a long line); the middle goes through an LCS.
 */
function regionsOf(a: readonly string[], b: readonly string[]): { regions: Region[]; kept: number } {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  let kept = weight(a, 0, head) + weight(a, a.length - tail);

  const n = a.length - head - tail;
  const m = b.length - head - tail;
  if (n === 0 && m === 0) return { regions: [], kept };
  if (n === 0 || m === 0 || n * m > MAX_LCS_CELLS) {
    return { regions: [{ a0: head, a1: head + n, b0: head, b1: head + m }], kept };
  }

  // lcs[i][j]: length of the LCS of a[head + i ..] and b[head + j ..], rows of m + 1 cells.
  const w = m + 1;
  const lcs = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[head + i] === b[head + j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    }
  }
  const regions: Region[] = [];
  let open: Region | null = null;
  const close = (): void => {
    if (open) regions.push(open);
    open = null;
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[head + i] === b[head + j]) {
      close();
      if (!SPACE_RE.test(a[head + i]!)) kept += a[head + i]!.length;
      i++;
      j++;
      continue;
    }
    open ??= { a0: head + i, a1: head + i, b0: head + j, b1: head + j };
    if (i < n && (j >= m || lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!)) {
      i++;
      open.a1 = head + i;
    } else {
      j++;
      open.b1 = head + j;
    }
  }
  close();
  return { regions, kept };
}

/** Common start and end (in characters) of two words. */
function affixes(x: string, y: string): { head: number; tail: number } {
  const max = Math.min(x.length, y.length);
  let head = 0;
  while (head < max && x[head] === y[head]) head++;
  let tail = 0;
  while (tail < max - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;
  return { head, tail };
}

/** Joins ranges separated by blanks only: `foo bar` → `baz qux` is one change, not two with an unmarked space. */
function bridge(text: string, ranges: Range[]): Range[] {
  const out: [number, number][] = [];
  for (const [start, end] of ranges) {
    const last = out[out.length - 1];
    if (last && /^\s*$/u.test(text.slice(last[1], start))) last[1] = end;
    else out.push([start, end]);
  }
  return out;
}

/**
 * Changed ranges of an `oldText` line and the `newText` line that replaces it. `null` when they are the same text.
 * A single word edited in place keeps its shared letters unmarked when most of it is kept (`price` → `prices` marks the `s`).
 */
export function markPair(oldText: string, newText: string): PairMarks | null {
  if (oldText === newText) return null;
  const a = tokenize(oldText);
  const b = tokenize(newText);
  const { regions, kept } = regionsOf(a, b);
  const at = offsets(a);
  const bt = offsets(b);
  const oldRanges: Range[] = [];
  const newRanges: Range[] = [];
  for (const r of regions) {
    let [os, oe, ns, ne] = [at[r.a0]!, at[r.a1]!, bt[r.b0]!, bt[r.b1]!];
    if (r.a1 - r.a0 === 1 && r.b1 - r.b0 === 1 && WORD_RE.test(a[r.a0]!) && WORD_RE.test(b[r.b0]!)) {
      const x = a[r.a0]!;
      const y = b[r.b0]!;
      const { head, tail } = affixes(x, y);
      if (head + tail >= WORD_REFINE_SHARE * Math.max(x.length, y.length)) {
        os += head;
        oe -= tail;
        ns += head;
        ne -= tail;
      }
    }
    if (oe > os) oldRanges.push([os, oe]);
    if (ne > ns) newRanges.push([ns, ne]);
  }
  const total = weight(a) + weight(b);
  return {
    old: bridge(oldText, oldRanges),
    new: bridge(newText, newRanges),
    // Two blank-only lines (an indentation change) are alike for what they are.
    similarity: total === 0 ? 1 : (2 * kept) / total,
  };
}

/** A run of removed lines directly followed by a run of added lines: indexes into the sequence given to `findBlocks`. */
export interface Block {
  dels: number[];
  adds: number[];
}

/**
 * The change blocks of a sequence of line kinds (`'hunk'` for a hunk header, which ends a block). A "No newline at end
 * of file" marker between the removals and the additions does not split them.
 */
export function findBlocks(kinds: readonly string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < kinds.length) {
    if (kinds[i] !== 'del') {
      i++;
      continue;
    }
    const dels: number[] = [];
    while (i < kinds.length && (kinds[i] === 'del' || kinds[i] === 'noeol')) {
      if (kinds[i] === 'del') dels.push(i);
      i++;
    }
    const adds: number[] = [];
    while (i < kinds.length && kinds[i] === 'add') adds.push(i++);
    if (adds.length > 0) blocks.push({ dels, adds });
  }
  return blocks;
}

export interface BlockMarks {
  /** Changed ranges per removed line (same order as the input); `null`: no counterpart, or the same text. */
  old: (Range[] | null)[];
  /** Same for the added lines. */
  new: (Range[] | null)[];
}

/**
 * Which removed line pairs with which added line, and what changed in each pair. Blocks of equal size pair line by line
 * when every pair is alike enough, which is nearly always; otherwise (and for unequal blocks) the monotone pairing with the
 * highest total similarity wins, and lines with no alike counterpart stay unmarked.
 */
export function markBlock(dels: readonly string[], adds: readonly string[]): BlockMarks {
  const n = dels.length;
  const m = adds.length;
  const out: BlockMarks = { old: new Array(n).fill(null), new: new Array(m).fill(null) };
  const cache = new Map<number, PairMarks | null>();
  const pair = (i: number, j: number): PairMarks | null => {
    const key = i * m + j;
    if (!cache.has(key)) cache.set(key, markPair(dels[i]!, adds[j]!));
    return cache.get(key)!;
  };
  const alike = (i: number, j: number): number => {
    const p = pair(i, j);
    return p && p.similarity >= MIN_SIMILARITY ? p.similarity : -1;
  };
  const take = (i: number, j: number): void => {
    const p = pair(i, j);
    if (!p) return;
    out.old[i] = p.old.length > 0 ? p.old : null;
    out.new[j] = p.new.length > 0 ? p.new : null;
  };

  if (n === m && (n * m > MAX_BLOCK_PAIRS || Array.from({ length: n }, (_, i) => alike(i, i)).every((s) => s >= 0))) {
    // Too many pairs to compare them all, or every diagonal pair is alike: line by line (the unlike ones left unmarked).
    for (let i = 0; i < n; i++) if (alike(i, i) >= 0) take(i, i);
    return out;
  }
  if (n * m > MAX_BLOCK_PAIRS) return out;

  // best[i][j]: highest total similarity pairing dels[i..] with adds[j..].
  const w = m + 1;
  const best = new Float64Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const s = alike(i, j);
      best[i * w + j] = Math.max(best[(i + 1) * w + j]!, best[i * w + j + 1]!, s >= 0 ? s + best[(i + 1) * w + j + 1]! : 0);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const s = alike(i, j);
    const here = best[i * w + j]!;
    if (s >= 0 && Math.abs(here - (s + best[(i + 1) * w + j + 1]!)) < 1e-9) {
      take(i, j);
      i++;
      j++;
    } else if (Math.abs(here - best[(i + 1) * w + j]!) < 1e-9) i++;
    else j++;
  }
  return out;
}

/** The text cut at `ranges`, each piece telling whether it is a changed one. */
export function segments(text: string, ranges: readonly Range[]): { text: string; changed: boolean }[] {
  const out: { text: string; changed: boolean }[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) out.push({ text: text.slice(at, start), changed: false });
    out.push({ text: text.slice(start, end), changed: true });
    at = end;
  }
  if (at < text.length) out.push({ text: text.slice(at), changed: false });
  return out;
}
