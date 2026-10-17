// MP-05: a branch `topic` whose merge into main conflicts in three different ways, off the base of the `divergent` fixture (main~3,
// where main already modifies g.txt): f.txt changed on both sides, both.txt added on both sides, g.txt deleted by topic.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupFn } from '../support';

export const setup: SetupFn = (fx) => {
  const write = (name: string, content: string) => writeFileSync(join(fx.repo, name), content);
  fx.git('switch', '-q', '-c', 'topic', 'main~3');
  write('f.txt', 'line 1\nline 2 (topic)\nline 3\n');
  write('both.txt', 'topic\n');
  fx.git('rm', '-q', 'g.txt');
  fx.git('add', 'f.txt', 'both.txt');
  fx.git('commit', '-q', '-m', 'topic: f.txt, both.txt, g.txt');
  fx.git('switch', '-q', 'main');
  write('f.txt', 'line 1\nline 2 (main)\nline 3\n');
  write('both.txt', 'main\n');
  fx.git('add', 'f.txt', 'both.txt');
  fx.git('commit', '-q', '-m', 'main: f.txt, both.txt');
};
