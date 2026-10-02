// GH-02 — List and clone (, 10). Fixture: linear, connected; clone of octo-test/alpha by the smart HTTP of the mock (credential inline).
import { join } from 'node:path';
import { expect } from '@wdio/globals';
import { currentMock, currentSession } from '../helpers';
import { git } from '../../support/git-state';
import { eventCount } from '../../support/graph';
import { appReady, click, countOf, textOf, typeInto, until, waitForTestId } from '../../support/ui';
import { loginViaUi, readLogLines } from './flows-b-support';

it("GH-02 — List and clone", async () => {
  const { tmp } = currentSession();
  const mock = currentMock();
  const dest = join(tmp, 'alpha-clone');
  await appReady();
  await loginViaUi();

  // "My repositories...": clone-dialog on the GitHub tab, local filter, choice of repository
  await click('toolbar-github-btn');
  await click('github-repos-btn');
  await waitForTestId('github-repo-picker', { attrs: { state: 'ready' } });
  expect(await countOf('github-repo-item')).toBe(3);
  await typeInto('github-repos-search-input', 'alpha');
  await until(async () => (await countOf('github-repo-item')) === 1, { message: 'le filtre local devrait ne garder qu’alpha' });
  await click('github-repo-item', { fullName: 'octo-test/alpha' });
  await typeInto('clone-dest-input', dest);
  const progressBefore = await eventCount('op:progress');
  await click('github-repo-clone-btn');

  // cloned repository opens (repo_clone → RepoInfo)
  await until(async () => (await textOf('toolbar-repo-name')).includes('alpha-clone'), { message: "cloned repository should be opened" });
  expect(git(dest, 'remote', 'get-url', 'origin')).toBe(`${mock.baseUrl}/octo-test/alpha.git`);
  expect(await eventCount('op:progress')).toBeGreaterThan(progressBefore);

  // credential inline: the mock received Basic x-access-token:gho_test; the token is not in any journal
  expect(
    mock.calls().some((c) => c.path.startsWith('/octo-test/alpha.git') && c.auth?.scheme === 'Basic' && c.auth.login === 'x-access-token'),
  ).toBe(true);
  expect(readLogLines().some((l) => l.includes('gho_test'))).toBe(false);
});
