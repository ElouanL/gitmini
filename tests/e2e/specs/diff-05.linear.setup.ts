// DIFF-05: `ctx.txt` (40 lines) is committed, then a second commit changes lines 8 and 34, and the worktree changes lines 20 and 30:
//   - line 20, `qty` becomes `quantity` (one word replaced);
//   - line 30, ` beta` is appended inside a string (a pure insertion).
// The worktree changes are 9 unchanged lines apart (one hunk from 5 lines of context); the commit's are 25 apart (one hunk from 13).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupFn } from '../helpers';

const base = (): string[] => Array.from({ length: 40 }, (_, i) => `step ${i + 1}: noop`);
const text = (lines: string[]): string => lines.map((l) => `${l}\n`).join('');

export const setup: SetupFn = (fx) => {
  const lines = base();
  lines[19] = 'const total = price * qty;';
  lines[29] = 'let label = "alpha";';
  writeFileSync(join(fx.repo, 'ctx.txt'), text(lines));
  fx.git('add', 'ctx.txt');
  fx.git('commit', '-q', '-m', 'add ctx.txt');

  lines[7] = 'step 8: retry twice';
  lines[33] = 'step 34: noop (done)';
  writeFileSync(join(fx.repo, 'ctx.txt'), text(lines));
  fx.git('add', 'ctx.txt');
  fx.git('commit', '-q', '-m', 'tune ctx.txt');

  lines[19] = 'const total = price * quantity;';
  lines[29] = 'let label = "alpha beta";';
  writeFileSync(join(fx.repo, 'ctx.txt'), text(lines));
};
