// UNDO-07 — Undo out of date (, 11). Fixture: linear; commit in the application, then `git commit --allow-empty -m ext` in terminal. STALE: level I.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, head } from '../../support/git-state';
import { appReady, isEnabled, until } from '../../support/ui';
import { commitInApp } from './flows-b-support';

it("UNDO-07 — Expired undo", async () => {
  const { repo } = currentSession();
  await appReady();
  await commitInApp('feat-y.txt', 'feat: y');
  expect(await isEnabled('toolbar-undo-btn')).toBe(true);

  git(repo, 'commit', '-q', '--allow-empty', '-m', 'ext');
  const extOid = head(repo);

  // the branch moved out of gitmini (ref-moved): undo disabled, HEAD unchanged
  await until(async () => !(await isEnabled('toolbar-undo-btn')), { message: "toolbar-undo-btn should be disabled (ref-moved)" });
  expect(head(repo)).toBe(extOid);
});
