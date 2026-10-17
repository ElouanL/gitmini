// TAG-02: a second remote, `backup` (an empty bare repository next to origin), and a lightweight tag v1.1 that no remote has.
import { join } from 'node:path';
import type { SetupFn } from '../helpers';

export const setup: SetupFn = async (fx) => {
  const bare = join(fx.root, 'backup.git');
  fx.gitIn(fx.root, 'init', '-q', '--bare', '-b', 'main', 'backup.git');
  fx.git('remote', 'add', 'backup', bare);
  fx.git('tag', 'v1.1', 'HEAD~1');
};
