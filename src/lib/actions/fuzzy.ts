// Fuzzy matching of the palette: every character of a word must appear in the text, in order, ignoring case and accents.
// A match scores higher when it starts the text or a word, when its characters sit next to each other and when the text
// is short, so "fetch" finds "Fetch" before "Prefetch objects" and "lb" still finds "Branch: list branches".
//
// A letter may only skip ahead over a few characters (`MAX_FREE_GAP`) unless it lands on the start of a word, which is
// what keeps "theme" from matching "Fetch (all remotes)" while "fub" still finds "feature/ui/button".
// Scores only compare candidates of one query. `indices` are positions in the ORIGINAL text, for highlighting.

export interface FuzzyMatch {
  score: number;
  /** Sorted positions (UTF-16 code units of the original text) of the matched characters. */
  indices: number[];
}

const MARKS = /[̀-ͯ]/g;
/** Anything but printable ASCII (the rest takes the slow, accent-aware path). */
const NOT_PLAIN = /[^ -~]/;
/** Characters past this are not searched: a name or a subject that long has nothing useful after it. */
const MAX_TEXT = 160;

const MATCH = 16;
const CONSECUTIVE = 10;
const BONUS_START = 14;
const BONUS_BOUNDARY = 10;
const BONUS_CAMEL = 8;
/** Characters a match may skip between two letters that are not at the start of a word. */
const MAX_FREE_GAP = 3;
const GAP_START = 3;
const GAP_EXTEND = 1;
const LEADING_MAX = 5;
const EXACT = 60;
const NONE = -1e9;

/**
 * Lowercase without accents, with the SAME length as `s` (so an index into the result is an index into `s`).
 * `normalize()` of `palette.ts` may shorten a string, which is fine for plain comparisons but not for highlighting.
 */
export function fold(s: string): string {
  if (!NOT_PLAIN.test(s)) return s.toLowerCase();
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const f = c.normalize('NFD').replace(MARKS, '').toLowerCase();
    out += f.length === 1 ? f : (f[0] ?? c);
  }
  return out;
}

const isSeparator = (c: string): boolean => c === ' ' || c === '/' || c === '-' || c === '_' || c === '.' || c === ':' || c === '(' || c === '@' || c === '#' || c === ',' || c === '\\';
const isLower = (c: string): boolean => c !== c.toUpperCase() && c === c.toLowerCase();
const isUpper = (c: string): boolean => c !== c.toLowerCase() && c === c.toUpperCase();

/** How much a match starting at `i` is worth, from what precedes it. */
function boundaryBonus(text: string, i: number): number {
  if (i === 0) return BONUS_START;
  const prev = text[i - 1]!;
  if (isSeparator(prev)) return BONUS_BOUNDARY;
  if (isLower(prev) && isUpper(text[i]!)) return BONUS_CAMEL;
  return 0;
}

/** Best alignment of ONE word (no spaces) in `text`, or `null`. */
function matchWord(word: string, text: string, folded: string): FuzzyMatch | null {
  const m = word.length;
  const n = Math.min(folded.length, MAX_TEXT);
  if (m === 0) return { score: 0, indices: [] };
  if (m > n) return null;

  // Cheap rejection: is `word` a subsequence at all?
  let k = 0;
  for (let i = 0; i < n && k < m; i++) if (folded[i] === word[k]) k++;
  if (k < m) return null;

  // score[j * n + i]: best score with word[j] matched at text[i]; from[...]: where word[j-1] was matched.
  const score = new Float64Array(m * n).fill(NONE);
  const from = new Int32Array(m * n).fill(-1);
  const bonus = new Float64Array(n);
  for (let i = 0; i < n; i++) bonus[i] = boundaryBonus(text, i);

  for (let i = 0; i < n; i++) {
    if (folded[i] === word[0]) score[i] = MATCH + bonus[i]! - Math.min(i, LEADING_MAX);
  }
  for (let j = 1; j < m; j++) {
    const prev = (j - 1) * n;
    const cur = j * n;
    // Best earlier start with a gap before `i`: its penalty grows by one per skipped character.
    let gapScore = NONE;
    let gapFrom = -1;
    for (let i = j; i < n; i++) {
      if (gapScore > NONE) gapScore -= GAP_EXTEND;
      const entering = score[prev + i - 2];
      if (i >= 2 && entering !== undefined && entering > NONE && entering - GAP_START > gapScore) {
        gapScore = entering - GAP_START;
        gapFrom = i - 2;
      }
      if (folded[i] !== word[j]) continue;
      const adjacent = score[prev + i - 1] ?? NONE;
      const viaAdjacent = adjacent > NONE ? adjacent + CONSECUTIVE : NONE;
      // Skipping ahead: anywhere for the start of a word, a few characters otherwise.
      let skipScore = NONE;
      let skipFrom = -1;
      if (bonus[i]! > 0) {
        skipScore = gapScore;
        skipFrom = gapFrom;
      } else {
        for (let g = 1; g <= MAX_FREE_GAP && i - 1 - g >= 0; g++) {
          const before = score[prev + i - 1 - g]!;
          const candidate = before - GAP_START - (g - 1) * GAP_EXTEND;
          if (before > NONE && candidate > skipScore) {
            skipScore = candidate;
            skipFrom = i - 1 - g;
          }
        }
      }
      let best = NONE;
      let source = -1;
      if (viaAdjacent >= skipScore && viaAdjacent > NONE) {
        best = viaAdjacent;
        source = i - 1;
      } else if (skipScore > NONE) {
        best = skipScore;
        source = skipFrom;
      }
      if (source >= 0) {
        score[cur + i] = best + MATCH + bonus[i]!;
        from[cur + i] = source;
      }
    }
  }

  let end = -1;
  let top = NONE;
  const last = (m - 1) * n;
  for (let i = m - 1; i < n; i++) {
    const s = score[last + i]!;
    if (s > top) {
      top = s;
      end = i;
    }
  }
  if (end < 0) return null;
  const indices = new Array<number>(m);
  for (let j = m - 1, i = end; j >= 0; j--) {
    indices[j] = i;
    i = from[j * n + i]!;
  }
  let total = top;
  if (folded.length === m && indices[0] === 0 && indices[m - 1] === m - 1) total += EXACT;
  // Between equal matches the shorter text wins.
  return { score: total - Math.min(text.length, 100) * 0.05, indices };
}

/**
 * Match `query` against `text`. The query is cut at spaces and EVERY word must match (in any order), which is how
 * "filter bra" finds "Filter branches and tags". An empty query matches everything with score 0.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return { score: 0, indices: [] };
  const folded = fold(text);
  let score = 0;
  const marked = new Set<number>();
  for (const word of words) {
    const found = matchWord(word, text, folded);
    if (!found) return null;
    score += found.score;
    for (const i of found.indices) marked.add(i);
  }
  return { score, indices: [...marked].sort((a, b) => a - b) };
}

/** `indices` as `[start, end)` runs, to cut a text into highlighted and plain parts. */
export function runs(indices: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const i of indices) {
    const tail = out[out.length - 1];
    if (tail && tail[1] === i) tail[1] = i + 1;
    else out.push([i, i + 1]);
  }
  return out;
}

export interface TextPart {
  text: string;
  match: boolean;
}

/** `text` cut into parts, the matched ones flagged. Always concatenates back to `text`. */
export function highlight(text: string, indices: readonly number[]): TextPart[] {
  if (indices.length === 0) return [{ text, match: false }];
  const parts: TextPart[] = [];
  let at = 0;
  for (const [from, to] of runs(indices)) {
    if (from > at) parts.push({ text: text.slice(at, from), match: false });
    parts.push({ text: text.slice(from, to), match: true });
    at = to;
  }
  if (at < text.length) parts.push({ text: text.slice(at), match: false });
  return parts;
}

export interface Ranked<T> {
  item: T;
  score: number;
  indices: number[];
}

/** Items that match `query`, best first; equal scores keep their original order. Empty query: everything, in order. */
export function rank<T>(items: readonly T[], query: string, textOf: (item: T) => string): Ranked<T>[] {
  const out: Ranked<T>[] = [];
  for (const item of items) {
    const found = fuzzyMatch(query, textOf(item));
    if (found) out.push({ item, score: found.score, indices: found.indices });
  }
  // `Array.prototype.sort` is stable.
  return out.sort((a, b) => b.score - a.score);
}
