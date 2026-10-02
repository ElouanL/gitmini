// ROB-08 — repository folder deleted — Linux only (Sharpen jump marker: @linux-only).
// `repo:changed` with all Kinds, then `repo-missing-screen` (NOT_FOUND { workdir }); neither crash nor toast cascade.
import { existsSync, rmSync } from 'node:fs';
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { eventCount, lastEvent } from '../../support/graph';
import { appReady, countOf, until, waitForTestId } from '../../support/ui';

it("ROB-08 — deletion of the repository folder: repo:changed (all Kinds) then repo-missing-screen, without toast cascade", async () => {
  const { repo } = currentSession();
  await appReady();
  const before = await eventCount('repo:changed');

  rmSync(repo, { recursive: true, force: true });

  await until(async () => (await eventCount('repo:changed')) > before, { message: "repo:changed never received after folder deletion" });
  await until(
    async () => {
      const kinds = ((await lastEvent<{ kinds: string[] }>('repo:changed'))?.kinds ?? []).slice().sort();
      return ['head', 'index', 'refs', 'stash', 'worktree'].every((k) => kinds.includes(k));
    },
    { message: "the repo:changed disappearance should wear all the kind" },
  );
  await waitForTestId('repo-missing-screen');

  // no crash (the front still answers), or cascade of toasts: the failing rereadings do not produce any
  expect(await countOf('toast', { kind: 'error' })).toBe(0);
  expect(await countOf('toast')).toBeLessThanOrEqual(1);
  await waitForTestId('repo-missing-screen-close-btn');
  // git: the folder no longer exists
  expect(existsSync(repo)).toBe(false);
});
