// RM-03: The scenario starts from the feature branch (unpublished).
import type { SetupFn } from '../helpers';

export const setup: SetupFn = async (fx) => {
  fx.git('switch', 'feature');
};
