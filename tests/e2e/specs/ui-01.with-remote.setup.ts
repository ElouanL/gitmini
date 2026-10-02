// IU-01: `other` pushes 1 commit on origin/main AFTER the last local fetch: the fetch of the palette has to repatriate it.
import type { SetupFn } from '../helpers';

export const setup: SetupFn = async (fx) => {
  fx.gitIn(fx.other, 'commit', '-q', '--allow-empty', '-m', 'other: commit pousse apres le fetch');
  fx.gitIn(fx.other, 'push', '-q', 'origin', 'HEAD:main');
};
