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
test('Playwright focus, fixme, expected failures and retries are rejected, plain tests are not', () => {
  const spec = 'tests/playwright/specs/a.spec.ts';
  assert.equal(inspectSource(spec, 'test.only("a", async () => {});').length, 1);
  assert.equal(inspectSource(spec, 'test.describe.only("a", () => {});').length, 1);
  assert.equal(inspectSource(spec, 'test.describe.parallel.only("a", () => {});').length, 1);
  assert.equal(inspectSource(spec, 'test.skip("a", async () => {});').length, 1);
  assert.equal(inspectSource(spec, 'test.fixme("a", async () => {});').length, 1);
  assert.equal(inspectSource(spec, 'test("a", async () => { test.skip(process.platform === "win32", "linux only"); });').length, 1);
  assert.equal(inspectSource(spec, 'test("a", async ({}, testInfo) => { testInfo.skip(); });').length, 1);
  assert.equal(inspectSource(spec, 'test("a", async () => { test.info().fixme(); });').length, 1);
  assert.equal(inspectSource(spec, 'test("a", async () => { test.fail(); });').length, 1);
  assert.equal(inspectSource(spec, 'test.describe.configure({ retries: 2 });').length, 1);
  assert.equal(inspectSource('tests/playwright/playwright.config.ts', 'export default { retries: process.env.CI ? 2 : 0 };').length, 1);
  assert.equal(inspectSource('tests/playwright/playwright.config.ts', 'export default { retries: 0, forbidOnly: true };').length, 0);
  assert.equal(inspectSource(spec, 'test.use({ scenario: { fixture: "linear" } }); test.describe("a", () => { test("b", async () => {}); });').length, 0);
  assert.equal(inspectSource('src/lib/ipc/retry.ts', 'export const policy = { retries: 3 };').length, 0, 'retries are only forbidden in tests/');
});
test('ignored Rust tests and quarantines require explicit provenance', () => {
  assert.equal(inspectSource('crates/a.rs', '#[ignore]\nfn test() {}').length, 1);
  assert.equal(inspectSource('crates/a.rs', '#[ignore = "perf: cargo test --release -- --ignored perf_"]\nfn perf_a() {}').length, 0);
  assert.equal(inspectSource('src/a.test.ts', '// @quarantine').length, 1);
  assert.equal(inspectSource('src/a.test.ts', '// @quarantine #123').length, 0);
});
