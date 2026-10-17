import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scenarioId, sessionId } from './naming';

const info = (title: string, extra: { retry?: number; repeatEachIndex?: number } = {}) => ({
  file: '/x/tests/playwright/specs/ui-12.with-remote.spec.ts',
  title,
  retry: 0,
  repeatEachIndex: 0,
  ...extra,
});

describe('naming', () => {
  it('scenarioId follows the <id>.<fixture>.spec.ts convention, else the file stem', () => {
    assert.equal(scenarioId('/a/ui-12.with-remote.spec.ts'), 'UI-12');
    assert.equal(scenarioId('/a/pw-01.linear.spec.ts'), 'PW-01');
    assert.equal(scenarioId('/a/misc.spec.ts'), 'misc');
  });

  it('sessionId is a short readable folder name, unique per title, without a doubled scenario id', () => {
    const id = sessionId(info('UI-12 — prefixes become folders that fold; the filter narrows every list'));
    assert.match(id, /^UI-12--prefixes-become-folders-that-fold-the-fi-[0-9a-f]{6}$/);
    assert.notEqual(sessionId(info('a long title that is the same for forty characters, then A')), sessionId(info('a long title that is the same for forty characters, then B')));
    assert.match(sessionId(info('x', { retry: 1, repeatEachIndex: 2 })), /^UI-12--x-[0-9a-f]{6}--retry1--repeat2$/);
  });
});
