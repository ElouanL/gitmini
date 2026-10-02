// STAGE-06 — Commit impossible without message or file staged (, 05). Fixture: dirty-worktree, empty index (setup).
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { head } from '../../support/git-state';
import { appReady, click, idle, isEnabled, tid, typeInto, until, waitForTestId } from '../../support/ui';

it("STAGE-06 — commit-submit-btn disabled without index or summary, active when both are combined", async () => {
  const { repo } = currentSession();
  await appReady();
  await click('graph-wip-row');
  await waitForTestId('commit-form');
  const before = head(repo);

  // Nothing from staged: disabled, empty summary or not.
  expect(await isEnabled('commit-submit-btn')).toBe(false);
  await typeInto('commit-summary-input', "feel: no index");
  expect(await isEnabled('commit-submit-btn')).toBe(false);
  await typeInto('commit-summary-input', '');

  // A staged file but no summary: disabled.
  const stage = (await $(`${tid('wt-unstaged-item', { path: 'mod.txt' })} ${tid('wt-stage-file-btn')}`)) as unknown as WebdriverIO.Element;
  await stage.waitForClickable({ timeout: 10_000 });
  await stage.click();
  await idle();
  await waitForTestId('wt-staged-item', { attrs: { path: 'mod.txt' } });
  expect(await isEnabled('commit-submit-btn')).toBe(false);

  // Non-empty index AND non-empty summary: active.
  await typeInto('commit-summary-input', "feel: with index");
  await until(() => isEnabled('commit-submit-btn'), { message: "the button should activate with a summary and a staged file" });
  expect(head(repo)).toBe(before); // nothing was committed
});
