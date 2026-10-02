// UI-07 — git absent or too old (, ). @linux-only: the fake `git` is a sh script.
// Fixture `linear` , application launched with `gitmini <path>` : the restitory must not be open.
import { expect } from '@wdio/globals';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { currentSession, restartApp } from '../helpers';
import { appReady, attrOf, countOf, textOf, waitForTestId } from '../../support/ui';

async function ipcCalls(): Promise<string[]> {
  return browser.execute(() => (window as unknown as { __gitmini: { ipc: { calls(): string[] } } }).__gitmini.ipc.calls());
}

describe('UI-07 — Interface : git absent ou trop ancien', () => {
  it("UI-07 — fake git 2.25.1: GIT_TOO_OLD with found and required versions; PATH without git: GIT_MISSING; no repository commands", async () => {
    await appReady({ graph: false });

    // 1. git 2.25.1 in the PATH
    await waitForTestId('welcome-git-error', { attrs: { code: 'GIT_TOO_OLD' } });
    const text = await textOf('welcome-git-error');
    expect(text).toContain('2.25.1'); // version found
    expect(text).toContain('2.30'); // version requise
    expect(await countOf('graph-canvas')).toBe(0); // the repository passed in argument is not open
    expect(await countOf('welcome-open-btn')).toBe(0); // "No other action possible"
    // IPC journal: only app_info was called, no repository commands (repo_open, log_page, status_get...)
    expect(await ipcCalls()).toEqual(['app_info']);

    // 2. variant after restart: a PATH without any git
    const { tmp } = currentSession();
    const empty = join(tmp, 'no-git');
    mkdirSync(empty, { recursive: true });
    await restartApp({ env: { PATH: empty } });
    await appReady({ graph: false });
    await waitForTestId('welcome-git-error', { attrs: { code: 'GIT_MISSING' } });
    expect(await attrOf('welcome-git-error', 'data-code')).toBe('GIT_MISSING');
    expect(await ipcCalls()).toEqual(['app_info']);
  });
});
