// RSV-01 — Resolve conflicts with one click: take ours / take theirs. Fixture `rebase-conflict`, HEAD on main, merge of
// `feature` stopped on conflict.txt (both modified), added.txt (both added) and README.md (deleted by us).
import { expect } from '@wdio/globals';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentSession } from '../helpers';
import { git, gitOk, gitRaw, opFiles, statusPorcelainV2 } from '../../support/git-state';
import {
  appReady, chooseContextItem, click, contextMenuActions, idle, isEnabled, press, rightClick, textOf, until, waitForGone, waitForTestId,
} from '../../support/ui';

const conflictRow = (path: string) => ({ path });

describe('RSV-01 — Conflicts: take ours or theirs', () => {
  it("RSV-01 — theirs from the diff, ours from the context menu, ours (a deletion) from the keyboard; then the merge finishes", async () => {
    const { repo } = currentSession();
    await appReady();
    await waitForTestId('op-banner', { attrs: { kind: 'merge', phase: 'conflict' } });
    for (const path of ['conflict.txt', 'added.txt', 'README.md']) await waitForTestId('wt-conflict-item', { attrs: conflictRow(path) });
    expect(git(repo, 'diff', '--name-only', '--diff-filter=U').split('\n').sort()).toEqual(['README.md', 'added.txt', 'conflict.txt']);
    expect(await isEnabled('op-banner-continue-btn')).toBe(false);

    // 1. Diff of conflict.txt: both sides are offered, named after the merge; "theirs" keeps feature's version.
    // A resolution by hand that is about to be replaced must stay recoverable.
    const byHand = 'line 1\nhand-written resolution\nline 3\n';
    writeFileSync(join(repo, 'conflict.txt'), byHand);
    const byHandOid = git(repo, 'hash-object', 'conflict.txt');
    expect(gitOk(repo, 'cat-file', '-e', byHandOid).status).not.toBe(0);

    await click('wt-conflict-item', conflictRow('conflict.txt'));
    await waitForTestId('diff-viewer', { attrs: { source: 'conflict', path: 'conflict.txt' } });
    expect(await textOf('diff-conflict-take-ours-btn')).toBe('Take ours: HEAD');
    expect(await textOf('diff-conflict-take-theirs-btn')).toBe('Take theirs: feature');
    await click('diff-conflict-take-theirs-btn');
    await idle();
    await waitForGone('wt-conflict-item', { attrs: conflictRow('conflict.txt') });
    await waitForGone('diff-viewer');
    expect(readFileSync(join(repo, 'conflict.txt'), 'utf8')).toBe(gitRaw(repo, 'show', 'feature:conflict.txt'));
    expect(gitRaw(repo, 'show', ':conflict.txt')).toBe(gitRaw(repo, 'show', 'feature:conflict.txt'));
    expect(gitOk(repo, 'cat-file', '-e', byHandOid).status).toBe(0); // the replaced content is saved as a blob
    expect(git(repo, 'diff', '--name-only', '--diff-filter=U').split('\n').sort()).toEqual(['README.md', 'added.txt']);

    // 2. Context menu of added.txt: the two entries; "ours" keeps main's version.
    await rightClick('wt-conflict-item', conflictRow('added.txt'));
    expect(await contextMenuActions()).toEqual(expect.arrayContaining(['resolve-ours', 'resolve-theirs']));
    await chooseContextItem('resolve-ours');
    await idle();
    await waitForGone('wt-conflict-item', { attrs: conflictRow('added.txt') });
    expect(readFileSync(join(repo, 'added.txt'), 'utf8')).toBe('added by main\n');
    expect(git(repo, 'show', ':added.txt')).toBe('added by main');

    // 3. Keyboard on README.md (main deleted it): `o` takes ours, which deletes the file.
    await click('wt-conflict-item', conflictRow('README.md'));
    await waitForTestId('diff-conflict-take-ours-btn');
    expect(await textOf('diff-conflict-take-ours-btn')).toBe('Take ours: HEAD');
    await press('o');
    await idle();
    await waitForGone('wt-conflict-item', { attrs: conflictRow('README.md') });
    expect(existsSync(join(repo, 'README.md'))).toBe(false);
    expect(git(repo, 'ls-files', '--', 'README.md')).toBe('');
    expect(git(repo, 'diff', '--name-only', '--diff-filter=U')).toBe('');

    // 4. Nothing is left in conflict: the merge can finish, and the result is what was chosen.
    await until(() => isEnabled('op-banner-continue-btn'), { message: 'Finishing the merge should turn on once every conflict is resolved' });
    await click('op-banner-continue-btn');
    await idle();
    await waitForGone('op-banner');
    expect(opFiles(repo).mergeHead).toBe(false);
    expect(git(repo, 'rev-list', '--parents', '-n1', 'main').split(' ')).toHaveLength(3);
    expect(git(repo, 'show', 'main:conflict.txt')).toBe(git(repo, 'show', 'feature:conflict.txt'));
    expect(git(repo, 'show', 'main:added.txt')).toBe('added by main');
    expect(git(repo, 'ls-tree', '--name-only', 'main', '--', 'README.md')).toBe('');
    expect(statusPorcelainV2(repo)).toEqual([]);
  });
});
