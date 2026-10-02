import { beforeEach, afterEach, expect, it } from 'vitest';
import { safeToRestart } from './global.svelte';
import { app } from '../stores/app.svelte';
import { repo } from '../stores/repo.svelte';
import { Session, activeSession } from '../stores/session.svelte';
import { opFor } from '../stores/op.svelte';
import { commitFormFor } from '../components/commit-form/form-state.svelte';
import { makeConflictState } from '../test/fixtures';
import { beginActivity } from '../activity';
import { resetAll } from '../test/reset';

beforeEach(() => { resetAll(); app.ready = true; });
afterEach(() => { resetAll(); });

it('protects drafts and operations in inactive tabs and hidden amend drafts', () => {
  const background = new Session();
  background.begin(2);
  repo.tabs = [activeSession.current, background];
  expect(safeToRestart()).toBe(true);
  const draft = commitFormFor(background);
  draft.activate('/background');
  draft.summary = 'unsaved';
  expect(safeToRestart()).toBe(false);
  draft.activate('/another');
  expect(draft.summary).toBe('');
  expect(safeToRestart()).toBe(false);
  draft.reset();
  const op = opFor(background);
  const end = op.begin('push');
  expect(safeToRestart()).toBe(false);
  end();
  op.setState(makeConflictState());
  expect(safeToRestart()).toBe(false);
  op.reset();
  expect(safeToRestart()).toBe(true);
});

it('blocks repository repository, opening and pending asynchronous work', () => {
  repo.restoring = true;
  expect(safeToRestart()).toBe(false);
  repo.restoring = false;
  repo.opening = true;
  expect(safeToRestart()).toBe(false);
  repo.opening = false;
  const end = beginActivity('settings');
  expect(safeToRestart()).toBe(false);
  end();
  expect(safeToRestart()).toBe(true);
});
