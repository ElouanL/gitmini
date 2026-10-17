// TAG-04: HEAD is on `feature` (two commits, unpublished, so the toolbar Push opens the push dialog), with three tags the dialog's
// "Also push annotated tags" box decides on: `rel-1.0` (annotated, on the tip of feature), `light-1` (lightweight, on a commit the
// branch carries) and `elsewhere` (annotated, on a commit of the local branch `wip`: not on feature, and on no remote either).
// (git's --follow-tags also delivers an annotated tag whose commit the remote already has, so the commit must be one it lacks.)
import type { SetupFn } from '../helpers';

export const setup: SetupFn = async (fx) => {
  fx.git('switch', '-c', 'wip', 'main');
  fx.git('commit', '--allow-empty', '-q', '-m', 'wip: work in progress');
  fx.git('tag', '-a', '-m', 'Elsewhere', 'elsewhere');
  fx.git('switch', 'feature');
  fx.git('tag', '-a', '-m', 'Release 1', 'rel-1.0');
  fx.git('tag', 'light-1', 'HEAD~1');
};
