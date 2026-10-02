import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { max, mean, median, percentile, round } from './lib/stats.mjs';
import { MARKS, firstMark, frameDurationsBetween, lastMark, parseTrace, readTraceFile } from './lib/trace.mjs';

test("median: odd, even, empty, unfinished values ignored", () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([312, 301, 340, 295, 305]), 305);
  assert.ok(Number.isNaN(median([])));
  assert.equal(median([1, NaN, 3, Infinity - Infinity, 2]), 2);
});

test("percentile: nearest rank method", () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(hundred, 95), 95);
  assert.equal(percentile(hundred, 100), 100);
  assert.equal(percentile(hundred, 0), 1);
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([16.6, 16.7, 16.7, 17.0, 60], 95), 60);
  assert.equal(percentile([7], 95), 7);
  assert.ok(Number.isNaN(percentile([], 95)));
});

test('mean, max, round', () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5);
  assert.equal(max([3, 9, 2]), 9);
  assert.ok(Number.isNaN(max([])));
  assert.equal(round(16.6666, 1), 16.7);
  assert.equal(round(0.12345, 3), 0.123);
});

const TRACE = [
  '{"kind":"mark","name":"gitmini:app-ready","t":1790972000100.5}',
  '{"kind":"mark","name":"gitmini:repo-open-start","t":1790972000400}',
  '{"kind":"frame","dt":16.7,"t":1790972000410}',
  "not json",
  '{"kind":"frame","dt":17.1,"t":1790972000427}',
  '{"kind":"mark","name":"gitmini:graph-first-paint","t":1790972001000}',
  '{"kind":"frame","dt":55,"t":1790972001100}',
  '{"kind":"mark","name":"gitmini:graph-index-complete","t":1790972001400}',
  '{"kind":"mark","name":"gitmini:graph-first-paint","t":1790972009000}',
  '{"kind":"frame","t":1790972009100}', // frame without duration: ignored
  "{\"kind\":\"mark\",\"name\":\"sans-t\"}", // without time stamping: ignored
  '{"kind":"mark","name":"gitmini:graph-index-co', // truncated line (file read during l \' writing)
  '',
].join('\n');

test("parseTrace : marks, frames, unreadable lines ignored", () => {
  const t = parseTrace(TRACE);
  assert.equal(t.marks.length, 5);
  assert.equal(t.frames.length, 3);
  assert.equal(t.skipped, 4);
  assert.deepEqual(t.frames.map((f) => f.dt), [16.7, 17.1, 55]);
});

test("parseTrace: tolerant format (without `kind`, `frame` field of the perf.rs unit test)", () => {
  const t = parseTrace('{"frame":16.7,"t":1}\n{"name":"gitmini:app-ready","t":2}\n{"duration":20,"t":3}\n');
  assert.deepEqual(t.frames, [{ dt: 16.7, t: 1 }, { dt: 20, t: 3 }]);
  assert.deepEqual(t.marks, [{ name: 'gitmini:app-ready', t: 2 }]);
});

test('firstMark / lastMark / frameDurationsBetween', () => {
  const t = parseTrace(TRACE);
  assert.equal(firstMark(t.marks, MARKS.graphFirstPaint).t, 1790972001000);
  assert.equal(lastMark(t.marks, MARKS.graphFirstPaint).t, 1790972009000);
  assert.equal(firstMark(t.marks, MARKS.graphFirstPaint, { after: 1790972002000 }).t, 1790972009000);
  assert.equal(firstMark(t.marks, 'unknown'), undefined);
  assert.equal(lastMark(t.marks, 'unknown'), undefined);
  assert.deepEqual(frameDurationsBetween(t.frames, 1790972000400, 1790972001000), [16.7, 17.1]);
  const open = firstMark(t.marks, MARKS.repoOpenStart);
  const paint = firstMark(t.marks, MARKS.graphFirstPaint);
  assert.equal(paint.t - open.t, 600);
});

test("readTraceFile: missing file = empty trace; read file", () => {
  const dir = mkdtempSync(join(tmpdir(), 'gitmini-perf-test-'));
  try {
    assert.deepEqual(readTraceFile(join(dir, 'absent.jsonl')), { marks: [], frames: [], skipped: 0 });
    writeFileSync(join(dir, 't.jsonl'), TRACE);
    assert.equal(readTraceFile(join(dir, 't.jsonl')).marks.length, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
