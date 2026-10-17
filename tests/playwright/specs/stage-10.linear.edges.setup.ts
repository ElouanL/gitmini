// STAGE-10 (edges): two files whose diffs stress the patch built for a few lines.
//  - `tail.txt` is committed without a final newline, then its last line is changed (`c` becomes `C`, still without a
//    newline): the change is two lines, each followed by `\ No newline at end of file`.
//  - `notes.txt` is a new file that Git does not track yet: its diff is five added lines.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupFn } from '../support';

export const NOTES = ['n1', 'n2', 'n3', 'n4', 'n5'];

export const setup: SetupFn = (fx) => {
  writeFileSync(join(fx.repo, 'tail.txt'), 'a\nb\nc');
  fx.git('add', 'tail.txt');
  fx.git('commit', '-q', '-m', 'add tail.txt');
  writeFileSync(join(fx.repo, 'tail.txt'), 'a\nb\nC');
  writeFileSync(join(fx.repo, 'notes.txt'), NOTES.map((l) => `${l}\n`).join(''));
};
