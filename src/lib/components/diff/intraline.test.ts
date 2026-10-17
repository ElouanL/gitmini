import { describe, expect, it } from 'vitest';
import { findBlocks, markBlock, markPair, MAX_BLOCK_PAIRS, MAX_LCS_CELLS, MIN_SIMILARITY, segments, tokenize, type Range } from './intraline';

/** The changed text of each range, to read an expectation as words rather than offsets. */
const changed = (text: string, ranges: readonly Range[] | null | undefined): string[] => (ranges ?? []).map(([s, e]) => text.slice(s, e));

describe('tokenize', () => {
  it('splits words, runs of blanks and single punctuation marks, losing nothing', () => {
    expect(tokenize('const total = price * qty;')).toEqual(['const', ' ', 'total', ' ', '=', ' ', 'price', ' ', '*', ' ', 'qty', ';']);
    expect(tokenize('foo(a,b)')).toEqual(['foo', '(', 'a', ',', 'b', ')']);
    expect(tokenize('\t  x')).toEqual(['\t  ', 'x']);
    for (const s of ['', 'a.b->c', 'naïve café_1 日本語', 'emoji 😀!']) expect(tokenize(s).join('')).toBe(s);
  });

  it('keeps accented letters, digits and underscores in one word', () => {
    expect(tokenize('café_2 déjà')).toEqual(['café_2', ' ', 'déjà']);
  });

  it('keeps a surrogate pair whole', () => {
    expect(tokenize('😀😀')).toEqual(['😀', '😀']);
  });
});

describe('markPair', () => {
  it('marks the word that changed on each side', () => {
    const o = 'const total = price * qty;';
    const n = 'const total = price * quantity;';
    const m = markPair(o, n)!;
    expect(changed(o, m.old)).toEqual(['qty']);
    expect(changed(n, m.new)).toEqual(['quantity']);
    expect(m.similarity).toBeGreaterThan(0.7);
  });

  it('marks only what was added, and leaves the old side unmarked', () => {
    const o = 'foo(a, b)';
    const n = 'foo(a, b, c)';
    const m = markPair(o, n)!;
    expect(m.old).toEqual([]);
    expect(changed(n, m.new)).toEqual([', c']);
  });

  it('marks only what was removed', () => {
    const o = 'import { a, b } from "x";';
    const n = 'import { a } from "x";';
    const m = markPair(o, n)!;
    expect(changed(o, m.old)).toEqual([', b']);
    expect(m.new).toEqual([]);
  });

  it('is null for equal text', () => {
    expect(markPair('same', 'same')).toBeNull();
    expect(markPair('', '')).toBeNull();
  });

  it('cuts a word edited in place down to the letters that differ when most of it is kept', () => {
    const m = markPair('let price = 1;', 'let prices = 1;')!;
    expect(changed('let price = 1;', m.old)).toEqual([]);
    expect(changed('let prices = 1;', m.new)).toEqual(['s']);
    const n = markPair('getUserName()', 'getUserId()')!;
    expect(changed('getUserName()', n.old)).toEqual(['Name']);
    expect(changed('getUserId()', n.new)).toEqual(['Id']);
  });

  it('keeps a whole word marked when little of it is shared (no q[uanti]ty)', () => {
    const m = markPair('x = qty', 'x = quantity')!;
    expect(changed('x = qty', m.old)).toEqual(['qty']);
    expect(changed('x = quantity', m.new)).toEqual(['quantity']);
  });

  it('merges changes separated by blanks only', () => {
    const o = 'foo bar baz';
    const n = 'qux quux baz';
    const m = markPair(o, n)!;
    expect(changed(o, m.old)).toEqual(['foo bar']);
    expect(changed(n, m.new)).toEqual(['qux quux']);
  });

  it('keeps two changes apart when an unchanged word lies between them', () => {
    const o = 'a b c d e';
    const n = 'a X c Y e';
    const m = markPair(o, n)!;
    expect(changed(o, m.old)).toEqual(['b', 'd']);
    expect(changed(n, m.new)).toEqual(['X', 'Y']);
  });

  it('marks the indentation when only that changed', () => {
    const o = '  return x;';
    const n = '    return x;';
    const m = markPair(o, n)!;
    expect(changed(o, m.old)).toEqual(['  ']);
    expect(changed(n, m.new)).toEqual(['    ']);
    expect(m.similarity).toBe(1);
  });

  it('marks trailing whitespace that appeared', () => {
    const n = 'x = 1;  ';
    const m = markPair('x = 1;', n)!;
    expect(changed(n, m.new)).toEqual(['  ']);
  });

  it('marks a change in a line of blanks', () => {
    const m = markPair('    ', '\t')!;
    expect(m.old).toEqual([[0, 4]]);
    expect(m.new).toEqual([[0, 1]]);
    expect(m.similarity).toBe(1);
  });

  it('gives offsets in UTF-16 units that slice the text, surrogate pairs included', () => {
    const o = '😀 a 😀';
    const n = '😀 b 😀';
    const m = markPair(o, n)!;
    expect(changed(o, m.old)).toEqual(['a']);
    expect(changed(n, m.new)).toEqual(['b']);
    expect(m.old[0]).toEqual([3, 4]);
  });

  it('scores lines that share nothing near zero', () => {
    const m = markPair('return foo;', 'throw new Error(bar);')!;
    expect(m.similarity).toBeLessThan(MIN_SIMILARITY);
  });

  it('scores a small edit of a long line high', () => {
    const base = 'const result = await client.request({ method: "GET", path, headers, retries: 3 });';
    expect(markPair(base, base.replace('GET', 'POST'))!.similarity).toBeGreaterThan(0.9);
  });

  it('ranges are sorted and never touch', () => {
    const o = 'a b c d e f g h i j';
    const n = 'a 1 c 2 e 3 g 4 i 5';
    const m = markPair(o, n)!;
    for (const ranges of [m.old, m.new]) {
      ranges.forEach(([s, e], i) => {
        expect(s).toBeLessThan(e);
        if (i > 0) expect(s).toBeGreaterThan(ranges[i - 1]![1]);
      });
    }
  });

  it('does not run away on a long line whose middle differs entirely: that middle is marked as one change', () => {
    const word = (i: number): string => `w${i}`;
    const o = `start ${Array.from({ length: 400 }, (_, i) => word(i)).join(' ')} end`;
    const n = `start ${Array.from({ length: 400 }, (_, i) => word(i + 1000)).join(' ')} end`;
    expect(tokenize(o).length * tokenize(n).length).toBeGreaterThan(MAX_LCS_CELLS);
    const t0 = performance.now();
    const m = markPair(o, n)!;
    expect(performance.now() - t0).toBeLessThan(500);
    expect(m.old).toHaveLength(1);
    expect(o.slice(m.old[0]![0]).startsWith('w0')).toBe(true);
    expect(o.slice(0, m.old[0]![1]).endsWith('w399')).toBe(true);
  });

  it('finds a small edit in the middle of a very long line quickly (the common head and tail are set aside)', () => {
    const body = Array.from({ length: 1500 }, (_, i) => `t${i}`).join(' ');
    const o = `${body} OLD ${body}`;
    const n = `${body} NEW ${body}`;
    const t0 = performance.now();
    const m = markPair(o, n)!;
    expect(performance.now() - t0).toBeLessThan(500);
    expect(changed(o, m.old)).toEqual(['OLD']);
    expect(changed(n, m.new)).toEqual(['NEW']);
  });
});

describe('findBlocks', () => {
  it('pairs a run of removals with the run of additions that follows', () => {
    expect(findBlocks(['hunk', 'ctx', 'del', 'del', 'add', 'ctx', 'add'])).toEqual([{ dels: [2, 3], adds: [4] }]);
  });

  it('finds every block of a hunk, and a hunk header ends one', () => {
    expect(findBlocks(['del', 'add', 'ctx', 'del', 'add', 'add', 'hunk', 'del', 'hunk', 'add'])).toEqual([
      { dels: [0], adds: [1] },
      { dels: [3], adds: [4, 5] },
    ]);
  });

  it('ignores pure removals and pure additions', () => {
    expect(findBlocks(['ctx', 'del', 'del', 'ctx', 'add', 'add'])).toEqual([]);
    expect(findBlocks([])).toEqual([]);
  });

  it('does not let a "no newline" marker split the removals from the additions', () => {
    expect(findBlocks(['ctx', 'del', 'noeol', 'add', 'noeol'])).toEqual([{ dels: [1], adds: [3] }]);
  });

  it('additions before removals are not paired (git lists removals first)', () => {
    expect(findBlocks(['add', 'del'])).toEqual([]);
  });
});

describe('markBlock', () => {
  it('pairs equal-sized blocks line by line', () => {
    const dels = ['let a = 1;', 'let b = 2;', 'let c = 3;'];
    const adds = ['let a = 10;', 'let b = 20;', 'let c = 30;'];
    const m = markBlock(dels, adds);
    expect(dels.map((d, i) => changed(d, m.old[i]))).toEqual([['1'], ['2'], ['3']]);
    expect(adds.map((a, i) => changed(a, m.new[i]))).toEqual([['10'], ['20'], ['30']]);
  });

  it('aligns an inserted line instead of shifting every pairing', () => {
    const dels = ['alpha = 1;', 'gamma = 3;'];
    const adds = ['alpha = 10;', 'beta = brand_new_value();', 'gamma = 30;'];
    const m = markBlock(dels, adds);
    expect(changed(dels[0]!, m.old[0])).toEqual(['1']);
    expect(changed(dels[1]!, m.old[1])).toEqual(['3']);
    expect(changed(adds[0]!, m.new[0])).toEqual(['10']);
    expect(m.new[1]).toBeNull(); // the new line has no counterpart: left plain
    expect(changed(adds[2]!, m.new[2])).toEqual(['30']);
  });

  it('aligns a removed line the same way', () => {
    const dels = ['alpha = 1;', 'obsolete_call_here();', 'gamma = 3;'];
    const adds = ['alpha = 10;', 'gamma = 30;'];
    const m = markBlock(dels, adds);
    expect(m.old[1]).toBeNull();
    expect(changed(dels[2]!, m.old[2])).toEqual(['3']);
    expect(changed(adds[1]!, m.new[1])).toEqual(['30']);
  });

  it('leaves unlike lines plain rather than marking all of both', () => {
    const m = markBlock(['return foo;'], ['throw new Error(bar);']);
    expect(m.old).toEqual([null]);
    expect(m.new).toEqual([null]);
  });

  it('keeps pairing the alike lines of an equal-sized block when one pair is unlike', () => {
    const dels = ['let a = 1;', 'return foo;', 'let c = 3;'];
    const adds = ['let a = 10;', 'throw new Error(bar);', 'let c = 30;'];
    const m = markBlock(dels, adds);
    expect(changed(dels[0]!, m.old[0])).toEqual(['1']);
    expect(m.old[1]).toBeNull();
    expect(changed(dels[2]!, m.old[2])).toEqual(['3']);
  });

  it('marks nothing when the texts are the same', () => {
    const m = markBlock(['same'], ['same']);
    expect(m).toEqual({ old: [null], new: [null] });
  });

  it('pairs a big equal-sized block line by line without comparing every pair of lines', () => {
    const n = Math.ceil(Math.sqrt(MAX_BLOCK_PAIRS)) + 5;
    const dels = Array.from({ length: n }, (_, i) => `value_${i} = ${i};`);
    const adds = Array.from({ length: n }, (_, i) => `value_${i} = ${i + 1};`);
    const m = markBlock(dels, adds);
    expect(changed(dels[7]!, m.old[7])).toEqual(['7']);
    expect(changed(adds[7]!, m.new[7])).toEqual(['8']);
  });

  it('gives up on a big unequal block', () => {
    const dels = Array.from({ length: 30 }, (_, i) => `a_${i} = 1;`);
    const adds = Array.from({ length: 31 }, (_, i) => `a_${i} = 2;`);
    expect(30 * 31).toBeGreaterThan(MAX_BLOCK_PAIRS);
    const m = markBlock(dels, adds);
    expect(m.old.every((r) => r === null)).toBe(true);
    expect(m.new.every((r) => r === null)).toBe(true);
  });
});

describe('segments', () => {
  it('cuts the text into plain and changed pieces that read back as the text', () => {
    expect(segments('abcdef', [[1, 2], [4, 6]])).toEqual([
      { text: 'a', changed: false },
      { text: 'b', changed: true },
      { text: 'cd', changed: false },
      { text: 'ef', changed: true },
    ]);
  });

  it('starts with a changed piece and ends with one without empty pieces', () => {
    expect(segments('abc', [[0, 1]])).toEqual([{ text: 'a', changed: true }, { text: 'bc', changed: false }]);
    expect(segments('abc', [[0, 3]])).toEqual([{ text: 'abc', changed: true }]);
    expect(segments('abc', [])).toEqual([{ text: 'abc', changed: false }]);
    expect(segments('', [])).toEqual([]);
  });
});
