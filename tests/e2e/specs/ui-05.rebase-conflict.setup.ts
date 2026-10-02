// UI-05: rebase feature on hand stopped on conflict before the opening of the application (HEAD on feature in fixture).
import type { SetupFn } from '../helpers';
import { gitOk } from '../../support/git-state';

export const setup: SetupFn = async (fx) => {
  const r = gitOk(fx.repo, 'rebase', 'main');
  if (r.status === 0) throw new Error("git rebase hand had to stop on conflict (fixation rebase-conflict)");
};
