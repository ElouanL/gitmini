import { describe, expect, it } from 'vitest';
import { fold, fuzzyMatch, highlight, rank, runs } from './fuzzy';

const score = (q: string, text: string): number => fuzzyMatch(q, text)?.score ?? Number.NEGATIVE_INFINITY;

describe('fold', () => {
  it("lowercases and drops accents without changing the length", () => {
    expect(fold('École Générale')).toBe('ecole generale');
    expect(fold('Fetch')).toBe('fetch');
    for (const s of ['École', 'école', 'İstanbul', 'ß', 'naïve café', '日本語 commit 😀']) expect(fold(s)).toHaveLength(s.length);
  });
});

describe('fuzzyMatch', () => {
  it("needs every character of a word, in order", () => {
    expect(fuzzyMatch('fch', 'Fetch')).not.toBeNull();
    expect(fuzzyMatch('fetchh', 'Fetch')).toBeNull();
    expect(fuzzyMatch('hcf', 'Fetch')).toBeNull();
    expect(fuzzyMatch('x', 'Fetch')).toBeNull();
    expect(fuzzyMatch('longer than the text', 'abc')).toBeNull();
  });

  it("ignores case and accents on both sides", () => {
    expect(fuzzyMatch('ECOLE', 'école')).not.toBeNull();
    expect(fuzzyMatch('école', 'ECOLE')).not.toBeNull();
    expect(fuzzyMatch('cafe', 'Café du matin')?.indices).toEqual([0, 1, 2, 3]);
  });

  it("matches everything with an empty query", () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, indices: [] });
    expect(fuzzyMatch('   ', 'anything')).toEqual({ score: 0, indices: [] });
  });

  it("every space-separated word must match, in any order", () => {
    expect(fuzzyMatch('filter bra', 'Filter branches and tags')).not.toBeNull();
    expect(fuzzyMatch('bra filter', 'Filter branches and tags')).not.toBeNull();
    expect(fuzzyMatch('filter zzz', 'Filter branches and tags')).toBeNull();
  });

  it("reports the matched positions of the ORIGINAL text, sorted", () => {
    expect(fuzzyMatch('fetch', 'Fetch from remote')?.indices).toEqual([0, 1, 2, 3, 4]);
    expect(fuzzyMatch('rem', 'Fetch from remote')?.indices).toEqual([11, 12, 13]);
    // Decomposed accents keep their place: "é" written as e + U+0301 takes two positions.
    expect(fuzzyMatch('cole', 'école')?.indices).toEqual([2, 3, 4, 5]);
    // Two words: the union of both, sorted.
    expect(fuzzyMatch('remote fetch', 'Fetch from remote')?.indices).toEqual([0, 1, 2, 3, 4, 11, 12, 13, 14, 15, 16]);
  });

  it("only skips a few characters inside a word, but may jump to the start of a word", () => {
    // the letters of "theme" are all in "Fetch (all remotes)", too far apart to mean anything
    expect(fuzzyMatch('theme', 'Fetch (all remotes)')).toBeNull();
    expect(fuzzyMatch('theme', 'Toggle the light / dark theme')).not.toBeNull();
    expect(fuzzyMatch('ae', 'axxxxxe')).toBeNull();
    expect(fuzzyMatch('ae', 'abcde')).not.toBeNull(); // 3 skipped
    expect(fuzzyMatch('ae', 'abcdfe')).toBeNull(); // 4 skipped
    // initials of segments reach across any distance
    expect(fuzzyMatch('fub', 'feature/ui/button')?.indices).toEqual([0, 8, 11]);
    expect(fuzzyMatch('stch', 'Stash changes')?.indices).toEqual([0, 1, 6, 7]);
    expect(fuzzyMatch('gf', 'gitFetch')?.indices).toEqual([0, 3]);
    expect(fuzzyMatch('ftlg', 'feature/login')).not.toBeNull();
  });

  it("prefers the start of the text, then the start of a word, then the middle", () => {
    const start = score('fetch', 'Fetch all');
    const word = score('fetch', 'Run fetch');
    const middle = score('fetch', 'Prefetch');
    expect(start).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(middle);
  });

  it("prefers characters that sit together to scattered ones", () => {
    expect(score('pull', 'Pull now')).toBeGreaterThan(score('pull', 'Push the ultimate lines'));
    expect(score('mer', 'Merge')).toBeGreaterThan(score('mer', 'Make every release'));
  });

  it("prefers a word boundary, including camelCase and separators", () => {
    expect(score('lf', 'login-form')).toBeGreaterThan(score('lf', 'clifford'));
    expect(score('gf', 'gitFetch')).toBeGreaterThan(score('gf', 'agfa'));
    expect(score('lf', 'login/form')).toBeGreaterThan(score('lf', 'blfoo'));
  });

  it("puts an exact match first and breaks ties with the shorter text", () => {
    expect(score('fetch', 'Fetch')).toBeGreaterThan(score('fetch', 'Fetch all remotes'));
    expect(score('fetch', 'Fetch all')).toBeGreaterThan(score('fetch', 'Fetch all remotes'));
  });

  it("finds the best alignment, not the first one", () => {
    // "ab" appears scattered first (a...b) and together later (ab): the tight pair must win.
    expect(fuzzyMatch('ab', 'a--- ab')?.indices).toEqual([5, 6]);
  });

  it("does not search past the first 160 characters", () => {
    expect(fuzzyMatch('zz', `${'a'.repeat(200)}zz`)).toBeNull();
    expect(fuzzyMatch('zz', `zz${'a'.repeat(200)}`)).not.toBeNull();
  });
});

describe('runs and highlight', () => {
  it("groups adjacent positions into [start, end) runs", () => {
    expect(runs([0, 1, 2, 5, 7, 8])).toEqual([[0, 3], [5, 6], [7, 9]]);
    expect(runs([])).toEqual([]);
  });

  it("cuts a text into plain and matched parts that concatenate back to it", () => {
    const parts = highlight('Fetch from remote', [0, 1, 11, 12]);
    expect(parts).toEqual([
      { text: 'Fe', match: true },
      { text: 'tch from ', match: false },
      { text: 're', match: true },
      { text: 'mote', match: false },
    ]);
    expect(parts.map((p) => p.text).join('')).toBe('Fetch from remote');
    expect(highlight('Fetch', [])).toEqual([{ text: 'Fetch', match: false }]);
    expect(highlight('Fetch', [0, 1, 2, 3, 4])).toEqual([{ text: 'Fetch', match: true }]);
  });
});

describe('rank', () => {
  const items = ['Prefetch objects', 'Fetch', 'Run fetch now', 'Cherry-pick', 'Fetch all remotes'];

  it("keeps only matches, best first", () => {
    expect(rank(items, 'fetch', (s) => s).map((r) => r.item)).toEqual(['Fetch', 'Fetch all remotes', 'Run fetch now', 'Prefetch objects']);
  });

  it("returns everything in order for an empty query and keeps ties in their original order", () => {
    expect(rank(items, '', (s) => s).map((r) => r.item)).toEqual(items);
    expect(rank(['b one', 'a one'], 'one', (s) => s).map((r) => r.item)).toEqual(['b one', 'a one']);
  });
});
