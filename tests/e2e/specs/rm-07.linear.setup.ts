// RM-07: an empty repository bare (target of the new remote), created before the application is launched.
import type { SetupFn } from '../helpers';

export const setup: SetupFn = async (fx) => {
  fx.gitIn(fx.root, 'init', '-q', '--bare', '-b', 'main', 'upstream.git');
};
