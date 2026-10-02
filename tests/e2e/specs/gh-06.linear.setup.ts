// GH-06 : origin = https://github.com/octo-test/alpha.git (never contacted: no GITMINI_GITHUB_* variables), feature published (refs/remotes/origin/feature).
import type { SetupFn } from '../helpers';

export const setup: SetupFn = async (fx) => {
  fx.git('remote', 'add', 'origin', 'https://github.com/octo-test/alpha.git');
  fx.git('branch', 'feature');
  fx.git('update-ref', 'refs/remotes/origin/feature', 'HEAD');
};
