import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectSource } from './check-test-policy.mjs';

test('focus and skips in executable test calls fail, examples in strings do not', () => {
  assert.equal(inspectSource('src/a.test.ts', 'it.concurrent.only("case", () => {});').length, 1);
  assert.equal(inspectSource('src/a.test.ts', 'describe.skip("suite", () => {});').length, 1);
  assert.equal(inspectSource('src/a.test.ts', 'const example = "it.only()"; // describe.skip()').length, 0);
});
test('only known conditional performance and harness skips are allowed', () => {
  assert.equal(inspectSource('tests/perf/perf.e2e.ts', 'ctx.skip();').length, 0);
  assert.equal(inspectSource('tests/e2e/specs/new.e2e.ts', 'this.skip();').length, 1);
});
test('ignored Rust tests and quarantines require explicit provenance', () => {
  assert.equal(inspectSource('crates/a.rs', '#[ignore]\nfn test() {}').length, 1);
  assert.equal(inspectSource('crates/a.rs', '#[ignore = "perf: cargo test --release -- --ignored perf_"]\nfn perf_a() {}').length, 0);
  assert.equal(inspectSource('src/a.test.ts', '// @quarantine').length, 1);
  assert.equal(inspectSource('src/a.test.ts', '// @quarantine #123').length, 0);
});
