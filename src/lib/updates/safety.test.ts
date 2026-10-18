import { beforeEach, afterEach, expect, it } from 'vitest';
import { safeToUpdate } from './global.svelte';
import { app } from '../stores/app.svelte';
import { repo } from '../stores/repo.svelte';
import { Session, activeSession } from '../stores/session.svelte';
import { opFor } from '../stores/op.svelte';
import { uiFor } from '../stores/ui.svelte';
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
  expect(safeToUpdate()).toBe(true);
  const draft = commitFormFor(background);
  draft.activate('/background');
  draft.summary = 'unsaved';
  expect(safeToUpdate()).toBe(false);
  draft.activate('/another');
  expect(draft.summary).toBe('');
  expect(safeToUpdate()).toBe(false);
  draft.reset();
  const op = opFor(background);
  const end = op.begin('push');
  expect(safeToUpdate()).toBe(false);
  end();
  op.setState(makeConflictState());
  expect(safeToUpdate()).toBe(false);
  op.reset();
  expect(safeToUpdate()).toBe(true);
});

it('blocks repository restoring and opening, but not dialogs, menus or background activity', () => {
  repo.restoring = true;
  expect(safeToUpdate()).toBe(false);
  repo.restoring = false;
  repo.opening = true;
  expect(safeToUpdate()).toBe(false);
  repo.opening = false;
  const end = beginActivity('settings');
  expect(safeToUpdate()).toBe(true); // the user pressed the button and the preferences are flushed first
  end();
  uiFor(activeSession.current).paletteOpen = true;
  expect(safeToUpdate()).toBe(true);
});
