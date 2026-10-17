// TAG-01: the collaborator tagged v3.0 on its own commit and pushed it, so origin already holds a v3.0 that the main
// repository does not have (nor the commit it points to).
import type { SetupFn } from '../helpers';

export const setup: SetupFn = async (fx) => {
  fx.gitIn(fx.other, 'tag', 'v3.0');
  fx.gitIn(fx.other, 'push', '-q', 'origin', 'refs/tags/v3.0');
};
