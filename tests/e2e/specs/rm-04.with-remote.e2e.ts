// RM-04 — Push rejected not fast-forward (, 10). Fixture: with-remote (rm-04.with-remote.setup.ts).
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { appReady, click, idle, waitForTestId } from '../../support/ui';

it("RM-04 — push rejected not fast-forward", async () => {
  const { fx } = currentSession();
  await appReady();
  const originBefore = fx.gitIn(fx.origin, 'rev-parse', 'main');
  // ahead 1, behind 0 : push direct, without confirmation of forced push
  await waitForTestId('toolbar-ahead-behind', { attrs: { ahead: 1, behind: 0 } });

  await click('toolbar-push-btn');
  await idle();

  // REJECTED_NON_FF { operation: "push", stale: false }: the local remote-tracking is late → Pull; the bare is unchanged
  await waitForTestId('push-rejected-dialog', { attrs: { stale: 'false' } });
  await waitForTestId('push-rejected-pull-btn');
  expect(fx.gitIn(fx.origin, 'rev-parse', 'main')).toBe(originBefore);
});
