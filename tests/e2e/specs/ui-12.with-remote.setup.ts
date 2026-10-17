// UI-12: branches and tags that share prefixes, so that the sidebar has folders to fold and a filter to narrow.
// `feature` already exists in the fixture (a branch and a folder of that name cannot coexist), hence `epic/`.
import type { SetupFn } from '../helpers';

export const setup: SetupFn = async (fx) => {
  for (const name of ['bugfix/crash', 'bugfix/typo', 'epic/login', 'epic/ui/button', 'epic/ui/modal']) fx.git('branch', name, 'main');
  // Two of them also exist on origin (the push creates the remote-tracking refs); the others stay local.
  fx.git('push', '-q', 'origin', 'epic/login', 'epic/ui/button');
  fx.git('tag', 'release/1.0', 'main~1');
  fx.git('tag', 'release/1.1', 'main');
};
