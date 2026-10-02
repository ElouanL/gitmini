// RM-06 — Cancellation of a fetch (, 10). Fixture: with-remote, origin = smart HTTP of the mock, hold: ["git-upload-pack"].
import { expect } from '@wdio/globals';
import { currentMock, currentSession } from '../helpers';
import { refs } from '../../support/git-state';
import { eventCount } from '../../support/graph';
import { appReady, click, idle, isShown, textOf, until, waitForGone, waitForTestId, waitForToast } from '../../support/ui';
import { loginViaUi } from './flows-b-support';

it('RM-06 — annulation d’un fetch', async () => {
  const { repo } = currentSession();
  const mock = currentMock();
  await appReady();
  await loginViaUi(); // the mock retains only smart requests HTTP authenticated
  mock.config({ hold: ['git-upload-pack'] });
  const refsBefore = refs(repo);
  const stateEventsBefore = await eventCount('op:state');

  try {
    await click('toolbar-fetch-btn');
    await until(() => mock.calls().some((c) => c.held), { message: "the mock did not receive (retained) the request git-upload-pack" });
    // the progression is visible during operation [L], with its cancel button
    await waitForTestId('toolbar-op-progress');

    const t0 = Date.now();
    await click('toolbar-op-cancel-btn');
    await waitForToast('info'); // CANCELLED → « Operation cancelled. »
    expect(await textOf('toast[data-kind=info]')).toContain("Operation cancelled");
    expect(Date.now() - t0).toBeLessThan(3000);
    await waitForGone('toolbar-op-progress');
    await idle();
  } finally {
    mock.release();
  }

  expect(await isShown('toast[data-kind=error]')).toBe(false);
  expect(await eventCount('op:state')).toBe(stateEventsBefore);
  expect(refs(repo)).toEqual(refsBefore);
});
