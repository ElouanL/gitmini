// PAL-05: file-1.txt is modified in the worktree (not committed) and differs on branch `touch` too (a line added at the end there, one
// at the top here), so checking `touch` out would overwrite the local change: git refuses and the application offers to stash.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBranchCommit, type SetupFn } from '../support';

export const LOCAL_EDIT = 'local first line\ncontent of commit 1\n';

export const setup: SetupFn = (fx) => {
  createBranchCommit(fx.repo, { branch: 'touch', base: 'main', files: { 'file-1.txt': 'content of commit 1\ntouch line\n' }, message: 'touch: file-1.txt' });
  writeFileSync(join(fx.repo, 'file-1.txt'), LOCAL_EDIT);
};
