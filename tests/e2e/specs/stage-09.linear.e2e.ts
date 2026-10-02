// STAGE-09 — Missing identity (, 05). Fixture: linear without user.name or user.email (setup).
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, head } from '../../support/git-state';
import { appReady, byTid, click, idle, textOf, typeInto, until, waitForGone, waitForTestId } from '../../support/ui';

it("STAGE-09 — IDENTITY_MISSING : identity-dialog, local recording, commit restarted, updated commit-author", async () => {
  const { repo } = currentSession();
  await appReady();
  await click('graph-wip-row');
  await waitForTestId('commit-form');
  expect(await textOf('commit-author')).toContain("Identity not configured");
  const before = head(repo);

  await typeInto('commit-summary-input', "feel: with identity");
  await click('commit-submit-btn');
  await idle();
  await waitForTestId('identity-dialog');
  expect(head(repo)).toBe(before); // the commit was refused by git

  await typeInto('identity-name-input', 'Ada Lovelace');
  await typeInto('identity-email-input', 'ada@x.io');
  await byTid('identity-scope-select').selectByAttribute('value', "local");
  await click('identity-save-btn');
  await idle();

  // config_set_identity returned Identity, and the failed command was restarted with the same arguments.
  await waitForGone('identity-dialog');
  await until(() => head(repo) !== before, { message: "commit should be restarted automatically" });
  expect(git(repo, 'config', '--local', 'user.email')).toBe('ada@x.io');
  expect(git(repo, 'log', '-1', '--format=%an <%ae>')).toBe('Ada Lovelace <ada@x.io>');
  expect(git(repo, 'log', '-1', '--format=%s')).toBe("feel: with identity");

  // The successful commit selects the new commit (the form disappears): the form is reopened by the palette
  // ("Amend the last commit") to check that commit-author displays the Identity returned by config_set_identity.
  await click('toolbar-palette-btn');
  await click('palette-item', { commandId: 'commit.amend' });
  await waitForTestId('commit-form');
  await until(async () => (await textOf('commit-author')).includes('ada@x.io'), { message: "commit-author should display the input identity" });
  expect(await textOf('commit-author')).toContain('(local)');
});
