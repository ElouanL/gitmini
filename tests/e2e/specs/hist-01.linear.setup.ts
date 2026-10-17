// HIST-01: the `linear` fixture plus the history of tests/e2e/specs/history-support.ts.
import type { SetupFn } from '../helpers';
import { buildHistory } from './history-support';

export const setup: SetupFn = (fx) => {
  buildHistory(fx);
};
