// TRASH-03 starts from the same stopped merge as RSV-01: a merge of `feature` into `main` stopped on three conflicts before the
// application opens. `rebase-conflict` has HEAD on feature and a `conflict.txt` edited on both branches; this adds
//   README.md  : edited by feature, deleted by main  (deleted by us, HEAD is main)
//   added.txt  : added by both with different content (both added)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitOk, type SetupFn } from '../support';

export const setup: SetupFn = async (fx) => {
  const write = (name: string, content: string): void => writeFileSync(join(fx.repo, name), content);

  write('README.md', '# Fixture gitmini (feature)\n');
  write('added.txt', 'added by feature\n');
  fx.git('add', '-A');
  fx.git('commit', '-q', '-m', 'feature: edit README.md, add added.txt');

  fx.git('switch', '-q', 'main');
  fx.git('rm', '-q', 'README.md');
  write('added.txt', 'added by main\n');
  fx.git('add', '-A');
  fx.git('commit', '-q', '-m', 'main: delete README.md, add added.txt');

  if (gitOk(fx.repo, 'merge', 'feature').status === 0) throw new Error('git merge feature had to stop on conflicts (fixture rebase-conflict)');
};
