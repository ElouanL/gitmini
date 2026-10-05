// UI-12 — Folder that is not a repository: the picker offers `git init`.
// Web mode only: outside Tauri the folder picker is `window.prompt`, which the spec stubs; the native dialog cannot be driven.
import { expect } from '@wdio/globals';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { currentSession } from '../helpers';
import { appReady, attrOf, cancelDialog, click, confirmDialog, countOf, idle, until, waitForTestId } from '../../support/ui';
import { readSettings, stubFolderPicker } from './ui-support';

describe("UI-12 — Interface: init offered for a plain folder", () => {
  it("UI-12 — cancel leaves the folder untouched; confirm runs git init and opens the repository in a tab", async function () {
    const { tmp, mode, fx } = currentSession();
    if (mode !== 'web') this.skip();
    const plain = join(tmp, 'plain');
    await appReady({ graph: false });
    await waitForTestId('welcome-open-btn');
    await stubFolderPicker(plain);

    // Cancel: nothing is created, nothing is reported
    await click('welcome-open-btn');
    await cancelDialog('repo-init');
    await idle();
    expect(existsSync(join(plain, '.git'))).toBe(false);
    expect(await countOf('welcome-open-error')).toBe(0);
    expect(await countOf('toast[data-kind=error]')).toBe(0);
    expect(await countOf('repo-tab')).toBe(0);

    // Confirm: git init, then the repository opens with an unborn HEAD
    await click('welcome-open-btn');
    await confirmDialog('repo-init');
    await waitForTestId('repo-tab', { attrs: { path: plain } });
    await waitForTestId('graph-empty-state');
    expect(existsSync(join(plain, '.git'))).toBe(true);
    expect(fx.gitIn(plain, 'rev-parse', '--is-inside-work-tree')).toBe('true');
    expect(await attrOf('repo-tab', 'data-path')).toBe(plain);
    expect(await countOf('welcome-open-error')).toBe(0);
    expect(await countOf('toast[data-kind=error]')).toBe(0);
    await until(() => JSON.stringify(readSettings().recent ?? []).includes(plain), { message: "settings.json should list the initialized repository as recent" });
  });
});
