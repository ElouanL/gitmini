// PAL-04: branches that share prefixes, so that the fuzzy search has names to tell apart (`epic/ui/button`, `bugfix/crash`...).
import type { SetupFn } from '../support';

export const setup: SetupFn = (fx) => {
  for (const name of ['epic/login', 'epic/ui/button', 'epic/ui/modal', 'bugfix/crash']) fx.git('branch', name, 'main');
};
