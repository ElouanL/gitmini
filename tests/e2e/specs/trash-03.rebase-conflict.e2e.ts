// TRASH-03 — "Take theirs" keeps the conflicted file: the Discarded tab brings back the conflict markers.
// Fixture: rebase-conflict, merge of `feature` into `main` stopped on conflict.txt (trash-03.rebase-conflict.setup.ts).
import { expect } from '@wdio/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentSession } from '../helpers';
import { git, gitRaw } from '../../support/git-state';
import { appReady, click, clickInRow, idle, textOf, until, waitForGone, waitForTestId } from '../../support/ui';

describe('TRASH-03 — Conflict resolution is recoverable', () => {
  it('TRASH-03 — the conflicted file replaced by "take theirs" is listed as such and its markers can be restored', async () => {
    const { repo } = currentSession();
    const file = join(repo, 'conflict.txt');
    await appReady();
    await waitForTestId('op-banner', { attrs: { kind: 'merge', phase: 'conflict' } });
    const markers = readFileSync(file, 'utf8');
    expect(markers).toContain('<<<<<<<');

    await click('wt-conflict-item', { path: 'conflict.txt' });
    await waitForTestId('diff-viewer', { attrs: { source: 'conflict', path: 'conflict.txt' } });
    await click('diff-conflict-take-theirs-btn');
    await idle();
    await waitForGone('wt-conflict-item', { attrs: { path: 'conflict.txt' } });
    expect(readFileSync(file, 'utf8')).toBe(gitRaw(repo, 'show', 'feature:conflict.txt'));

    await click('reflog-panel-btn');
    await click('recovery-tab-discarded');
    await waitForTestId('trash-item', { attrs: { path: 'conflict.txt', source: 'resolve' } });
    expect(await textOf('trash-item-meta')).toMatch(/^Replaced while resolving · /);

    // The worktree gets the markers back; the index keeps the resolution, so the file is a plain local change.
    await clickInRow('trash-item', 'conflict.txt', 'trash-item-restore-btn');
    await idle();
    expect(readFileSync(file, 'utf8')).toBe(markers);
    expect(git(repo, 'diff', '--name-only', '--diff-filter=U')).not.toContain('conflict.txt');
    expect(gitRaw(repo, 'show', ':conflict.txt')).toBe(gitRaw(repo, 'show', 'feature:conflict.txt'));
    await until(async () => (await textOf('toast')).includes('Restored conflict.txt.'), { message: 'the restore should be announced' });
    await waitForTestId('wt-unstaged-item', { attrs: { path: 'conflict.txt' } });
  });
});
