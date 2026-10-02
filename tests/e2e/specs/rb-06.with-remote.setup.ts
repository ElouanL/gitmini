// RB-06: `feature` pushed (git push -u original feature), then 1 commit added on hand.
import type { SetupFn } from '../helpers';

export const setup: SetupFn = async (fx) => {
  fx.git('push', '-q', '-u', 'origin', 'feature');
  fx.git('commit', '-q', '--allow-empty', '-m', 'main: nouveau commit');
};
