// ROB-10 — Verrou tenu par un commit externe  : `git commit -- <path>` (commit partiel : git prend `index.lock`
// before the hook and guard it during `pre-commit`) blocked by a sentinel hook; the app commits during this time and receives
// BUSY { lock }; after release, `toast-retry-btn` makes his commit succeed. Both commits exist, git fsck passes.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, gitDir, head, listLocks, logSubjects } from '../../support/git-state';
import { release, waitReached } from '../../support/sentinel';
import { appReady, click, idle, textOf, typeInto, until, waitForTestId } from '../../support/ui';

it("ROB-10 — commit external blocked in pre-commit (index.lock held): BUSY { lock } in the app, then toast-retry-btn succeeds", async () => {
  const { repo, tmp, env } = currentSession();
  const sentinel = join(tmp, 'sentinels', 'pre-commit');
  await appReady();
  await click('graph-wip-row');
  await waitForTestId('commit-form');
  await waitForTestId('wt-staged-item', { attrs: { path: 'staged.txt' } }); // l'app commitera staged.txt
  const initial = head(repo);

  // commit external partial (mod.txt): git holds index.lock while the hook waits for the sentinel
  const external = spawn('git', ['-C', repo, 'commit', '-m', 'externe', '--', 'mod.txt'], { env, stdio: 'ignore' });
  const externalExit = new Promise<number | null>((resolveExit) => external.once('close', resolveExit));
  const lock = join(gitDir(repo), 'index.lock');
  try {
    await waitReached(sentinel);
    expect(existsSync(lock)).toBe(true); // It is well git that holds the lock (git >= 2.54, commit partial)

    // app commits during this time: BUSY { lock } → toast with Retry; message entered remains in the form
    await typeInto('commit-summary-input', "feel: from the app");
    await click('commit-submit-btn');
    await waitForTestId('toast-retry-btn');
    await until(async () => (await textOf('toast-container')).includes('index.lock'), { message: 'le toast devrait citer index.lock' });
    expect(head(repo)).toBe(initial); // neither commits exists yet
    // gitmini did not touch the git locks: the partial commit holds `index.lock` and its temporary index `next-index-<pid>.lock`
    expect(listLocks(repo)).toContain(lock);
    expect(listLocks(repo).filter((l) => l !== lock).every((l) => /[\\/]next-index-\d+\.lock$/.test(l))).toBe(true);
  } finally {
    release(sentinel); // in a finaly : otherwise git remains blocked (guard of the hook : 60 s)
  }

  // the external commit ends, the lock disappears (it's git that removes it)
  expect(await externalExit).toBe(0);
  await until(() => !existsSync(lock), { message: "index.lock should be removed by git at the end of commit" });
  const externalCommit = head(repo);
  expect(externalCommit).not.toBe(initial);

  // Try again: the same command, which now succeeds
  await click('toast-retry-btn');
  await idle();
  await until(() => head(repo) !== externalCommit, { message: "the commit of the app should exist after Retry" });

  // git: both commits, in this order, with the right content; repository includes
  expect(logSubjects(repo, '-2')).toEqual(["feel: from the app", 'externe']);
  expect(git(repo, 'show', '--name-only', '--format=', 'HEAD~1')).toBe('mod.txt');
  // the commit of the app contains what was staged (staged.txt and rename old.txt → new.txt), not mod.txt
  expect(git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['new.txt', 'staged.txt']);
  expect(git(repo, 'rev-list', '--count', `${initial}..HEAD`)).toBe('2');
  expect(listLocks(repo)).toEqual([]);
  git(repo, 'fsck', '--no-dangling', '--connectivity-only');
});
