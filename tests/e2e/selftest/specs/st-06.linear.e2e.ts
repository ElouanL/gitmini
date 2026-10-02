// Autotest of the harness (ST-06): voluntary failure for VOIR artifacts (screenshot, DOM, console, git state, archive of the
// tmpdir). Default inactive: GITMINI_SELFTEST_FAIL=1 pnpm --dir tests/e2e run selftest --spec selftest/specs/st-06.linear.e2e.ts
import { expect } from '@wdio/globals';
import { appReady } from '../../../support/ui';

describe("ST-06 — Voluntary failure (artifacts)", () => {
  it("ST-06 — fails only with GITMINI_SELFTEST_FAIL=1", async function () {
    if (process.env.GITMINI_SELFTEST_FAIL !== '1') this.skip();
    await appReady();
    expect(await $('[data-testid="selftest-counter"]').getText()).toBe('999');
  });
});
