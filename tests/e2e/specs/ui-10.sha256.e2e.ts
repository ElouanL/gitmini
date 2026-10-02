// UI-10 — Format of repository not supported (, ) Fixture `sha256` passed as argument; reftable and extension
// unknown have been opened since recent ones. The reftable variant is explicitly skipped under git < 2.45 (ALLOWED_SKIPS).
import { expect } from '@wdio/globals';
import { join } from 'node:path';
import { currentSession } from '../helpers';
import { gitVersion } from '../../support/fixture';
import { appReady, attrOf, click, countOf, idle, textOf, until, waitForTestId } from '../../support/ui';

async function expectRefused(reason: string): Promise<void> {
  await waitForTestId('welcome-open-error', { attrs: { code: 'UNSUPPORTED_REPO_FORMAT', reason } });
  expect(await attrOf('welcome-open-error', 'data-code')).toBe('UNSUPPORTED_REPO_FORMAT');
  expect(await attrOf('welcome-open-error', 'data-reason')).toBe(reason);
  expect(await countOf('graph-canvas')).toBe(0); // no graph is loaded
}

describe("UI-10 — Interface: repository format not supported", () => {
  it("UI-10 — sha256 in argument: welcome-open-error[data-code=UNSUPPORTED_REPO_FORMAT][data-reason=sha256]; rebuttable and extended since recent", async () => {
    const { tmp } = currentSession();
    await appReady({ graph: false });

    // 1. SHA -256, passed in argument: refused from the start, without graph
    await expectRefused('sha256');
    expect(await textOf('welcome-open-error')).toContain('SHA-256');

    // 2. rebuttable (git >= 2.45 only: otherwise explicitly jumped, )
    const [major, minor] = gitVersion();
    if (major > 2 || (major === 2 && minor >= 45)) {
      await click('welcome-recent-item', { path: join(tmp, 'reftable-repo') });
      await idle();
      await expectRefused('reftable');
    } else {
      console.log(`IU-10: reftable varying from skipped (git ${major}.${minor} < 2.45)`);
    }

    // 3. unknown extension: message names extension
    await click('welcome-recent-item', { path: join(tmp, 'extension-repo') });
    await idle();
    await expectRefused('extension');
    expect(await textOf('welcome-open-error')).toContain('gitminitest');

    // "Recoverable" refusals keep entry in recent
    await until(async () => (await countOf('welcome-recent-item')) >= 1, { message: "the recent ones should be retained" });
  });
});
