// MP-06: 202 files added on both sides with different content (add/add); the backend lists at most 200 of the conflicting files.
// `topic` leaves the base of the `divergent` fixture (main~3); main gets the same paths.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupFn } from '../support';

export const BULK = 202;

export const setup: SetupFn = (fx) => {
  const addBulk = (side: string) => {
    mkdirSync(join(fx.repo, 'bulk'), { recursive: true });
    for (let i = 0; i < BULK; i++) writeFileSync(join(fx.repo, 'bulk', `f-${String(i).padStart(3, '0')}.txt`), `${side}\n`);
    fx.git('add', 'bulk');
    fx.git('commit', '-q', '-m', `${side}: ${BULK} files in bulk/`);
  };
  fx.git('switch', '-q', '-c', 'topic', 'main~3');
  addBulk('topic');
  fx.git('switch', '-q', 'main');
  addBulk('main');
};
