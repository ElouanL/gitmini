// UI-08 — Denied opening (, 03, ) The application is running without a path; a repository bare is in recent ones.
import { expect } from '@wdio/globals';
import { join } from 'node:path';
import { currentSession } from '../helpers';
import { appReady, attrOf, click, countOf, idle, until, waitForGone, waitForTestId } from '../../support/ui';
import { readSettings } from './ui-support';

describe("UI-08 — Interface: opening refused", () => {
  it("UI-08 — click on a recent repository bare : welcome-open-error[data-code=NOT_A_REPO], entry disappears from recent", async () => {
    const { tmp } = currentSession();
    const bare = join(tmp, 'bare.git');
    await appReady({ graph: false });
    await waitForTestId('welcome-recent-list');
    await waitForTestId('welcome-recent-item', { attrs: { path: bare } });

    await click('welcome-recent-item', { path: bare });
    await idle();

    await waitForTestId('welcome-open-error', { attrs: { code: 'NOT_A_REPO' } });
    expect(await attrOf('welcome-open-error', 'data-reason')).toBe('bare');
    expect(await countOf('graph-canvas')).toBe(0); // no graphs have been loaded
    // the backend has removed the entry of recent, the interface has reread the list
    await waitForGone('welcome-recent-item', { attrs: { path: bare } });
    expect(await countOf('welcome-recent-item')).toBe(0);
    await until(() => !JSON.stringify(readSettings().recent ?? []).includes('bare.git'), { message: "settings.json should no longer list the repository bare" });
  });
});
