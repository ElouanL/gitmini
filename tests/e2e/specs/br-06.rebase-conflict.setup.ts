// BR-06: `rebase-conflict` fixture has HEAD on feature; on merge feature in hand.
import type { SetupFn } from '../helpers';

export const setup: SetupFn = async (fx) => {
  fx.git('switch', 'main');
};
