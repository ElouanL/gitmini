// Autotest of the harness (ST-07): a *.lock left in the repository makes the scenario fail even if its assertions pass.
// Default inactive: GITMINI_SELFTEST_LOCK=1 pnpm --dir tests/e2e run selftest --spec selftest/specs/st-07.linear.e2e.ts
// must end in CHEC with "integrity of the repository after ST-07: residual locks ... index.lock".
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from '@wdio/globals';
import { gitDir } from '../../../support/git-state';
import { currentSession } from '../../helpers';
import { appReady } from '../../../support/ui';

describe("ST-07 — Residual lock", () => {
  it("ST-07 — leaves index.lock: the hook afterEach of the harness must detect it", async function () {
    if (process.env.GITMINI_SELFTEST_LOCK !== '1') this.skip();
    const session = currentSession();
    await appReady();
    writeFileSync(join(gitDir(session.repo), 'index.lock'), '');
    expect(true).toBe(true); // the assertions of the test pass
  });
});
