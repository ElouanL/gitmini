// The `divergent` fixture has HEAD on hand: the scenario starts with feature (rebase of the current).
import type { SetupFn } from '../helpers';

export const setup: SetupFn = async (fx) => {
  fx.git('switch', 'feature');
};
