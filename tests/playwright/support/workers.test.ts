import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { workerCount } from './workers';

describe('workerCount', () => {
  it('defaults to 1, honours GITMINI_E2E_WORKERS and ignores nonsense', () => {
    assert.equal(workerCount({}), 1);
    assert.equal(workerCount({ GITMINI_E2E_WORKERS: '4' }), 4);
    assert.equal(workerCount({ GITMINI_E2E_WORKERS: '99' }), 16);
    assert.equal(workerCount({ GITMINI_E2E_WORKERS: '0' }), 1);
    assert.equal(workerCount({ GITMINI_E2E_WORKERS: 'many' }), 1);
    assert.equal(workerCount({ GITMINI_E2E_WORKERS: '2.5' }), 1);
  });
});
