// UNDO-05 — Undo impossible after push (, 11). Fixture: with-remote; hand updated, a commit made in the application then pushed.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { revParse } from '../../support/git-state';
import { appReady, attrOf, click, idle, isEnabled, until, waitForTestId } from '../../support/ui';
import { commitInApp } from './flows-b-support';

it("UNDO-05 — undo impossible after push", async () => {
  const { repo, fx } = currentSession();
  await appReady();

  await click('toolbar-pull-btn'); // main rejoint origin/main (ff-only)
  await idle();
  expect(revParse(repo, 'main')).toBe(revParse(repo, 'origin/main'));
  await commitInApp('rm-undo.txt', "feel: published");
  expect(await isEnabled('toolbar-undo-btn')).toBe(true);

  await click('toolbar-push-btn');
  await idle();
  expect(fx.gitIn(fx.origin, 'rev-parse', 'main')).toBe(revParse(repo, 'main'));

  // undo_peek → reason: "pushed" : button deactivated, explanatory infobulle
  await until(async () => !(await isEnabled('toolbar-undo-btn')), { message: "toolbar-undo-btn should be disabled after push" });
  await waitForTestId('toolbar-undo-btn');
  const title = ((await attrOf('toolbar-undo-btn', 'title')) ?? '').replace(/’/g, "'");
  expect(title).toBe("Cannot undo an operation that has already been published.");
});
