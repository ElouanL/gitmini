import { describe, expect, it } from 'vitest';
import { splitMessage } from '$lib/components/commit-form/commit-logic';
import { buildRewordTodo, checkRewordTarget, rewordMessage, splitRewordMessage } from './reword';

// Linear history r ← a ← b ← c ← d (HEAD = d).
const rows = (entries: Record<string, string[]>) => new Map(Object.entries(entries).map(([o, parents]) => [o, { parents }]));
const LINEAR = rows({ r: [], a: ['r'], b: ['a'], c: ['b'], d: ['c'] });

describe('checkRewordTarget', () => {
  it("commit of HEAD's history: upstream = its parent, later = commits above it", () => {
    expect(checkRewordTarget('b', LINEAR, 'd')).toEqual({ ok: true, upstream: 'a', later: 2 });
    expect(checkRewordTarget('d', LINEAR, 'd')).toEqual({ ok: true, upstream: 'c', later: 0 });
  });

  it("root commit: upstream null (--root)", () => {
    expect(checkRewordTarget('r', LINEAR, 'd')).toEqual({ ok: true, upstream: null, later: 4 });
  });

  it("merge between the target and HEAD, or the target itself a merge: merge", () => {
    const withMerge = rows({ r: [], a: ['r'], b: ['a'], x: ['r'], m: ['b', 'x'], c: ['m'] });
    expect(checkRewordTarget('a', withMerge, 'c')).toEqual({ ok: false, reason: 'merge' });
    expect(checkRewordTarget('m', withMerge, 'c')).toEqual({ ok: false, reason: 'merge' });
    expect(checkRewordTarget('c', withMerge, 'c')).toEqual({ ok: true, upstream: 'm', later: 0 });
  });

  it("commit of another branch: not-in-head", () => {
    const side = rows({ r: [], a: ['r'], b: ['a'], s1: ['a'], s2: ['s1'] });
    expect(checkRewordTarget('s1', side, 'b')).toEqual({ ok: false, reason: 'not-in-head' });
  });

  it("line not loaded on the way, or HEAD unknown: unknown", () => {
    const partial = rows({ a: ['r'], b: ['a'], d: ['c'] });
    expect(checkRewordTarget('a', partial, 'd')).toEqual({ ok: false, reason: 'unknown' });
    expect(checkRewordTarget('b', LINEAR, null)).toEqual({ ok: false, reason: 'unknown' });
  });
});

describe('buildRewordTodo', () => {
  const preview = ['a', 'b', 'c'].map((oid) => ({ oid }));

  it("pick everywhere, reword with the message on the target only", () => {
    expect(buildRewordTodo(preview, 'b', 'New\n\nbody')).toEqual([
      { oid: 'a', action: 'pick' },
      { oid: 'b', action: 'reword', message: 'New\n\nbody' },
      { oid: 'c', action: 'pick' },
    ]);
  });

  it("target missing from the preview: stale", () => {
    expect(buildRewordTodo(preview, 'x', 'm')).toBe('stale');
  });
});

describe('rewordMessage', () => {
  it("trimmed summary, description after a blank line, omitted when blank", () => {
    expect(rewordMessage('  Title ', '\nbody\n\n')).toBe('Title\n\nbody');
    expect(rewordMessage('Title', '   ')).toBe('Title');
  });

  it('keeps the indentation of the first description line: splitMessage then rewordMessage round-trips', () => {
    const original = 'Fix parser\n\n    $ cargo run -- --flag\n    prints x\n\nExplain.';
    const { summary, body } = splitMessage(original);
    expect(rewordMessage(summary, body)).toBe(original);
    expect(rewordMessage('Fix the parser', body)).toBe('Fix the parser\n\n    $ cargo run -- --flag\n    prints x\n\nExplain.');
    expect(rewordMessage('Title', '  \n\n  indented\n')).toBe('Title\n\n  indented');
  });

  it('a first paragraph on several lines stays one paragraph when only the description is edited', () => {
    const original = 'Fix parser\nhandle CRLF too\n\nDetails.';
    const split = splitRewordMessage(original);
    expect(split).toEqual({ summary: 'Fix parser', body: 'handle CRLF too\n\nDetails.', separator: '\n' });
    expect(rewordMessage(split.summary, split.body, split.separator)).toBe(original);
    expect(rewordMessage(split.summary, 'handle CRLF too\n\nMore details.', split.separator)).toBe(
      'Fix parser\nhandle CRLF too\n\nMore details.',
    );
    expect(splitRewordMessage('Title\n\nbody').separator).toBe('\n\n');
    expect(splitRewordMessage('Title').separator).toBe('\n\n');
  });
});
