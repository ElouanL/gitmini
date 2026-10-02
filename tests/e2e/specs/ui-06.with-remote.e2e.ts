// UI-06 — Toast error (, 03, ) Fixture `with-remote`, then the test deletes `../origin.git`.
import { expect } from '@wdio/globals';
import { rmSync } from 'node:fs';
import { currentSession } from '../helpers';
import { gitState } from '../../support/git-state';
import { appReady, click, idle, textOf, waitForGone, waitForToast } from '../../support/ui';

describe("UI-06 — Interface: toast error", () => {
  it("IU-06 — fetch of a missing remote: toast[data-kind=error], toast-details-btn shows the git stderr, toast-close-btn on the farm", async () => {
    const { repo, fx } = currentSession();
    await appReady();
    const before = gitState(repo);

    rmSync(fx.origin, { recursive: true, force: true });
    await click('toolbar-fetch-btn');
    await idle();

    await waitForToast('error');
    await click('toast-details-btn');
    // stderr de git (LC_ALL=C) : « fatal: '<path>/origin.git' does not appear to be a git repository »
    const text = await textOf('toast[data-kind=error]');
    expect(text).toContain('does not appear to be a git repository');

    await click('toast-close-btn');
    await waitForGone('toast[data-kind=error]');
    expect(gitState(repo)).toEqual(before); // a failed fetch does not change any ref
  });
});
