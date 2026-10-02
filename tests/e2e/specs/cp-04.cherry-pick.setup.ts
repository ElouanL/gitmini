// CP-04: HEAD on `merged` (which contains the `side` --no-ff merge): we're reverting this commit of merge.
import type { SetupFn } from '../helpers';

export const setup: SetupFn = async (fx) => {
  fx.git('switch', 'merged');
};
