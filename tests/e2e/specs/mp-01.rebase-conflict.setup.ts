// MP-01: the `rebase-conflict` fixture has HEAD on feature; the merge goes the other way, feature into main.
import type { SetupFn } from '../helpers';

export const setup: SetupFn = async (fx) => {
  fx.git('switch', 'main');
};
