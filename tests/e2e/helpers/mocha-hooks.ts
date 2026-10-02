// Hooks mocha "root" (mochaOpts.require): executed after CHAQUE CHAQUE spec test, without the spec having to
// declare: "A residual lock causes the scenario to fail, even if its assertions have passed."
// WDIO (`afterTest`) cannot fail the test; a `afterEach` mocha, yes.

import { writeText } from './artifacts';
import { maybeSession } from './app';
import { checkRepoIntegrity } from './session';
import { join } from 'node:path';

export const mochaHooks = {
  async afterEach(this: Mocha.Context): Promise<void> {
    const session = maybeSession();
    if (!session) return;
    const state = this.currentTest?.state;
    if (state === 'failed') session.failed = true;

    try {
      await checkRepoIntegrity(session);
    } catch (error) {
      session.failed = true;
      if (state === 'failed') {
        // the test has already failed: we keep the root cause, and we attach the integrity statement to the artifacts
        writeText(join(session.artifactsDir, 'integrity.txt'), `${String(error)}\n`);
        return;
      }
      throw new Error(`integrity of repository after ${session.id} : ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  },
};
