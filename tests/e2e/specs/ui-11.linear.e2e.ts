// UI-11 — Project tabs: distinct worktrees, drafts, watcher isolation and restart persistence.
import { expect } from '@wdio/globals';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentSession } from '../helpers';
import { appReady, click, idle, until, waitForTestId, allByTid } from '../../support/ui';
import { readSettings } from './ui-support';

interface Workspace { paths: string[]; activePath: string | null }

describe('UI-11 — Project tabs', () => {
  it('UI-11 — keeps two worktrees open, preserves drafts, routes changes and restores tabs after restart', async () => {
    const session = currentSession();
    const other = join(session.tmp, 'tabs-other');
    await appReady();
    expect(await allByTid('repo-tab')).toHaveLength(2);
    await (await waitForTestId('commit-summary-input')).setValue('Draft A');
    await click('repo-tab', { path: other });
    await idle();
    await (await waitForTestId('commit-summary-input')).setValue('Draft B');
    await click('repo-tab', { path: session.repo });
    await idle();
    expect(await (await waitForTestId('commit-summary-input')).getValue()).toBe('Draft A');
    await browser.execute(() => { document.querySelector<HTMLElement>('[data-testid="graph-viewport"]')!.scrollTop = 280; });
    await idle();
    await click('repo-tab', { path: other });
    await idle();
    await browser.execute(() => { document.querySelector<HTMLElement>('[data-testid="graph-viewport"]')!.scrollTop = 560; });
    await idle();
    await click('repo-tab', { path: session.repo });
    await idle();
    expect(await browser.execute(() => document.querySelector<HTMLElement>('[data-testid="graph-viewport"]')!.scrollTop)).toBe(280);
    await click('wt-unstaged-item', { path: 'tabs-a.txt' });
    await waitForTestId('diff-viewer');
    await click('repo-tab', { path: other });
    await idle();
    expect(await browser.execute(() => document.querySelector<HTMLElement>('[data-testid="graph-viewport"]')!.scrollTop)).toBe(560);
    expect(await browser.$('[data-testid="diff-viewer"]').isExisting()).toBe(false);
    await click('repo-tab', { path: session.repo });
    await waitForTestId('diff-viewer');
    await click('diff-close-btn');
    writeFileSync(join(other, 'background-b.txt'), 'External change in the inactive worktree\n');
    await click('repo-tab', { path: other });
    await idle();
    await waitForTestId('wt-unstaged-item', { attrs: { path: 'background-b.txt' } });
    expect(await (await waitForTestId('commit-summary-input')).getValue()).toBe('Draft B');
    expect(await (await waitForTestId('repo-tab', { attrs: { path: other } })).getAttribute('aria-selected')).toBe('true');
    await until(() => (readSettings()['workspace.tabs'] as Workspace | undefined)?.activePath === other);
    expect((readSettings()['workspace.tabs'] as Workspace).paths).toEqual([session.repo, other]);
    mkdirSync(session.artifactsDir, { recursive: true });
    await browser.saveScreenshot(join(session.artifactsDir, 'tabs-light.png'));
    await click('toolbar-settings-btn');
    await (await waitForTestId('settings-theme-select')).selectByAttribute('value', 'dark');
    await click('settings-close-btn');
    await idle();
    await browser.saveScreenshot(join(session.artifactsDir, 'tabs-dark.png'));
    await browser.reloadSession();
    await appReady();
    expect(await allByTid('repo-tab')).toHaveLength(2);
    expect(await (await waitForTestId('repo-tab', { attrs: { path: other } })).getAttribute('aria-selected')).toBe('true');
    await click('repo-tab-close-btn', { repoId: await (await waitForTestId('repo-tab', { attrs: { path: other } })).getAttribute('data-repo-id') as string });
    await idle();
    expect(await allByTid('repo-tab')).toHaveLength(1);
    expect(await (await waitForTestId('repo-tab', { attrs: { path: session.repo } })).getAttribute('aria-selected')).toBe('true');
    await click('repo-tabs-add-btn');
    const open = await waitForTestId('repo-tabs-open-btn');
    expect((await open.getLocation()).x).toBeGreaterThanOrEqual(0);
  });
});
