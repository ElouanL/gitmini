// RM-02 — Pull fast-forward, divergence, pull rebase (, 10). Fixture : with-remote.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, revParse } from '../../support/git-state';
import { appReady, click, idle, waitForTestId } from '../../support/ui';
import { gitSpawnLines, spawnCount } from './flows-b-support';

it('RM-02 — pull ff-only, divergence, pull rebase', async () => {
  const { repo, fx } = currentSession();
  await appReady();

  // default ff-only mode: `git fetch` then `git merge --ff-only <oid>`, never `git pull`
  await click('toolbar-pull-btn');
  await idle();
  expect(revParse(repo, 'main')).toBe(revParse(repo, 'origin/main'));
  const spawns = gitSpawnLines();
  expect(spawns.some((l) => l.includes('"fetch"'))).toBe(true);
  expect(spawns.some((l) => l.includes('"merge"') && l.includes('"--ff-only"'))).toBe(true);
  expect(spawnCount('pull')).toBe(0);

  // a local commit and a new commit pushed by other: divergence
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'local: commit divergent');
  writeFileSync(join(fx.other, 'other-rm02.txt'), 'rm-02\n');
  fx.gitIn(fx.other, 'add', 'other-rm02.txt');
  fx.gitIn(fx.other, 'commit', '-q', '-m', "other: adds other-rm02.txt");
  fx.gitIn(fx.other, 'push', '-q', 'origin', 'main');

  const mergesBefore = spawnCount('merge');
  await click('toolbar-pull-btn');
  await waitForTestId('pull-diverged-dialog');
  await idle();
  // REJECTED_NON_FF { operation: "pull", diverged: true }: no `git merge` launched, no commit of merge
  expect(spawnCount('merge')).toBe(mergesBefore);
  expect(git(repo, 'rev-list', '--merges', 'HEAD')).toBe('');

  await click('pull-diverged-rebase-btn');
  await idle();
  expect(git(repo, 'rev-list', '--merges', 'origin/main..main')).toBe('');
  expect(git(repo, 'merge-base', 'main', 'origin/main')).toBe(revParse(repo, 'origin/main'));
  expect(git(repo, 'log', '-1', '--format=%s', 'main')).toBe('local: commit divergent');
});
