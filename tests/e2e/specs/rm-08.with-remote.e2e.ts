// RM-08 — Writing lock (, 10). Fixture: with-remote, same setup as RM-06 (fetch retained by the mock).
import { browser, expect } from '@wdio/globals';
import { currentMock, currentSession } from '../helpers';
import { appReady, attrOf, click, idle, isEnabled, until, waitForGone, waitForTestId } from '../../support/ui';
import { loginViaUi, spawnCount } from './flows-b-support';

it("RM-08 — writing lock", async () => {
  const session = currentSession();
  const mock = currentMock();
  await appReady();
  await loginViaUi();
  mock.config({ hold: ['git-upload-pack'] });

  try {
    await click('toolbar-fetch-btn');
    await until(() => mock.calls().some((c) => c.held), { message: "the fetch is not retained by the mock" });
    await waitForTestId('toolbar-op-progress');

    // the interface refuses to write during the operation: button disabled, "Operation in progress: <label>" infobulle
    expect(await isEnabled('toolbar-push-btn')).toBe(false);
    expect(await attrOf('toolbar-push-btn', 'title')).toContain("Operation in progress");
    expect(spawnCount('push')).toBe(0);

    // the backend refuses anyway (BUSY { reason: "running" }): direct call from the HTTP bridge (browser mode only)
    if (session.mode === 'web') {
      const res = await browser.executeAsync(
        (base: string, done: (r: { status: number; body: { code?: string; details?: Record<string, unknown> } }) => void) => {
          fetch(`${base}/__gitmini/invoke/remote_push`, {
            method: 'POST',
            body: JSON.stringify({ repoId: 1, opId: crypto.randomUUID(), remote: 'origin', branch: 'main', setUpstream: false, forceWithLease: false }),
          })
            .then(async (r) => done({ status: r.status, body: await r.json() }))
            .catch((e) => done({ status: -1, body: { code: String(e) } }));
        },
        session.url as string,
      );
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('BUSY');
      expect(res.body.details?.reason).toBe('running');
      expect(res.body.details?.runningKind).toBeDefined();
      expect(spawnCount('push')).toBe(0);
    }
  } finally {
    mock.release(); // the selected fetch ends normally
  }
  await waitForGone('toolbar-op-progress');
  await idle();
  expect(spawnCount('push')).toBe(0);
});
