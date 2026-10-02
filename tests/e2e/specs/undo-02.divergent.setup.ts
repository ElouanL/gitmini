// UNDO-02: the scenario starts with feature (rebase of the current on hand, like RB-02).
import type { SetupFn } from '../helpers';

export const setup: SetupFn = async (fx) => {
  fx.git('switch', 'feature');
};
