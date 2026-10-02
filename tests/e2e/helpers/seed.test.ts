import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mulberry32, resolveSeed, shuffle } from './seed';

describe("seed and random order (13 §9.2)", () => {
  it("GITMINI_TEST_SEED digital or text gives a stable seed", () => {
    assert.deepEqual(resolveSeed('12345'), { seed: 12345, explicit: true });
    assert.equal(resolveSeed('abc').seed, resolveSeed('abc').seed);
    assert.notEqual(resolveSeed('abc').seed, resolveSeed('abd').seed);
    assert.equal(resolveSeed('99999999999999').seed >= 0, true); // run_id de CI : modulo 2^32
    assert.equal(resolveSeed('4294967297').seed, 1);
  });

  it("without value, a seed is drawn and marked not explicit", () => {
    const r = resolveSeed('');
    assert.equal(r.explicit, false);
    assert.ok(Number.isInteger(r.seed) && r.seed >= 0 && r.seed < 2 ** 32);
  });

  it("same seed = same order; input is not changed; it is a permutation", () => {
    const files = Array.from({ length: 40 }, (_, i) => `spec-${i}`);
    const copy = [...files];
    const a = shuffle(files, 42);
    assert.deepEqual(files, copy);
    assert.deepEqual(a, shuffle(files, 42));
    assert.notDeepEqual(a, files);
    assert.deepEqual([...a].sort(), [...files].sort());
    assert.notDeepEqual(a, shuffle(files, 43));
  });

  it("the shards of the same job find the same permutation (shared seed)", () => {
    const files = Array.from({ length: 12 }, (_, i) => `s${i}`);
    const order = shuffle(files, 7);
    // WDIO cuts the ordered list into N slices: the union of the shards is exactly the set of specs
    const shards = [order.slice(0, 6), order.slice(6)];
    assert.deepEqual([...shards.flat()].sort(), [...files].sort());
  });

  it("mulberry32 is deterministic and in [0, 1[", () => {
    const r1 = mulberry32(1);
    const r2 = mulberry32(1);
    for (let i = 0; i < 100; i++) {
      const v = r1();
      assert.equal(v, r2());
      assert.ok(v >= 0 && v < 1);
    }
  });
});
