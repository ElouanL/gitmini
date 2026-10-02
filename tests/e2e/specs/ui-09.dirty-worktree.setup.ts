// UI-09: a 2nd branch on HEAD, so that the navigation of the sidebar (▼) finds another branch than the current one.
import type { SetupFn } from '../helpers';

export const setup: SetupFn = async (fx) => {
  fx.git('branch', 'topic');
};
