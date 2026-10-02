// ROB-03 — External branch change: `git checkout -b ext` while the app is open.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, gitOk } from '../../support/git-state';
import { appReady, idle, until, textOf, waitForTestId } from '../../support/ui';

it("ROB-03 — git checkout -b ext : toolbar-current-branch displays ext", async () => {
  const { repo } = currentSession();
  await appReady();
  await until(async () => (await textOf('toolbar-current-branch')).includes('main'), { message: "the branch of departure should be hand" });

  expect(gitOk(repo, 'checkout', '-b', 'ext').status).toBe(0);

  await until(async () => (await textOf('toolbar-current-branch')).trim().endsWith('ext'), {
    message: "toolbar-current-branch should display ext without user action",
  });
  await waitForTestId('sidebar-branch-item', { attrs: { ref: 'refs/heads/ext', current: true } });
  await idle();

  expect(git(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/ext');
  expect(git(repo, 'rev-parse', 'ext')).toBe(git(repo, 'rev-parse', 'main'));
});
