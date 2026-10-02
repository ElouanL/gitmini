// ST-05 — See content and stash → branch (, 08). Fixture: stash-multi.
import { currentSession } from '../helpers';
import { browser, expect } from '@wdio/globals';
import { currentBranch, git, stashList } from '../../support/git-state';
import { appReady, click, idle, typeInto, waitForTestId } from '../../support/ui';

it("ST-05 — see content and stash → branch", async () => {
  const { repo } = currentSession();
  await appReady();
  expect(stashList(repo)).toHaveLength(3);

  // selection of stash@{2}: the files on the panel are those of `git stash show --name-only`
  await click('sidebar-stash-item', { index: 2 });
  await waitForTestId('stash-detail-panel');
  await waitForTestId('stash-detail-file-item');
  const expected = git(repo, 'stash', 'show', '--name-only', 'stash@{2}').split('\n').filter(Boolean).sort();
  const shown = await browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="stash-detail-file-item"]')).map((e) => e.getAttribute('data-path') ?? ''),
  );
  expect([...new Set(shown)].sort()).toEqual(expected);

  // the diff of a file opens in diff-viewer and resumes the lines of `git stash show -p`
  await click('stash-detail-file-item', { path: expected[0] as string });
  await waitForTestId('diff-viewer');
  const patch = git(repo, 'diff', 'stash@{2}^', 'stash@{2}', '--', expected[0] as string); // = `git stash show -p stash@{2}` limited to the file
  const added = patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
  expect(added.length).toBeGreaterThan(0);
  const text = await browser.execute(() => document.querySelector('[data-testid="diff-viewer"]')?.textContent ?? '');
  for (const line of added) expect(text).toContain(line);

  // back to graph, then stash → branch
  await click('diff-close-btn');
  await click('stash-branch-btn');
  await waitForTestId('stash-branch-dialog');
  await typeInto('stash-branch-name-input', 'from-stash');
  await click('stash-branch-confirm-btn');
  await idle();
  expect(currentBranch(repo)).toBe('from-stash');
  expect(git(repo, 'diff', '--name-only')).toContain('parser.txt');
  expect(stashList(repo)).toHaveLength(2);
});
