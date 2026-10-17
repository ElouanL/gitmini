// Settings: the "Diff context" choice (`diff.contextLines`), a native select like the other choices.
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { whenIdle } from '../../activity';
import { DIFF_CONTEXT_CHOICES, DIFF_CONTEXT_DEFAULT, normalizeDiffContext, stepDiffContext } from '../../ipc/settings-types';
import { app } from '../../stores/app.svelte';
import { createFakeTransport, type FakeTransport } from '../../test/fake-transport';
import { resetAll } from '../../test/reset';
import { updates } from '../../updates/global.svelte';
import SettingsDialog from './SettingsDialog.svelte';

let fake: FakeTransport;

beforeEach(() => {
  resetAll();
  app.load({});
  fake = createFakeTransport().install();
  vi.spyOn(updates, 'refresh').mockResolvedValue(undefined);
});
afterEach(() => { resetAll(); });

it('shows three lines by default and lists the choices in order, each with a readable label', () => {
  render(SettingsDialog, { close: vi.fn() });
  const select = screen.getByTestId<HTMLSelectElement>('settings-diff-context-select');
  expect(select.value).toBe('3');
  expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
    ['1', '1 line'], ['3', '3 lines'], ['5', '5 lines'], ['10', '10 lines'], ['25', '25 lines'],
  ]);
  expect(screen.getByLabelText('Diff context')).toBe(select);
  expect(select).toHaveAccessibleDescription(/Unchanged lines shown above and below each change/);
});

it('reflects the saved size', () => {
  app.load({ 'diff.contextLines': 10 });
  render(SettingsDialog, { close: vi.fn() });
  expect(screen.getByTestId<HTMLSelectElement>('settings-diff-context-select').value).toBe('10');
});

it('saves the choice as a number', async () => {
  render(SettingsDialog, { close: vi.fn() });
  const select = screen.getByTestId('settings-diff-context-select');
  await userEvent.selectOptions(select, '25');
  expect(app.get('diff.contextLines')).toBe(25);
  await whenIdle();
  await userEvent.selectOptions(select, '1');
  await whenIdle();
  expect(fake.callsOf('settings_set').map((c) => c.args)).toEqual([
    { key: 'diff.contextLines', value: 25 },
    { key: 'diff.contextLines', value: 1 },
  ]);
});

it('is a native select reached by Tab in the order of the form', async () => {
  render(SettingsDialog, { close: vi.fn() });
  const select = screen.getByTestId('settings-diff-context-select');
  expect(select.tagName).toBe('SELECT');
  expect(select).toBeEnabled();
  screen.getByTestId('settings-fetch-auto-select').focus();
  await userEvent.tab();
  expect(select).toHaveFocus();
});

it('goes back to the previous value when the backend refuses the new one', async () => {
  fake.on('settings_set', () => { throw { code: 'INVALID_ARGUMENT', message: 'no', details: { field: 'value' } }; });
  render(SettingsDialog, { close: vi.fn() });
  await userEvent.selectOptions(screen.getByTestId('settings-diff-context-select'), '5');
  await whenIdle();
  expect(app.get('diff.contextLines')).toBe(3);
});

it('keeps the front choices in step with the default and the stepping rules', () => {
  expect(DIFF_CONTEXT_CHOICES).toContain(DIFF_CONTEXT_DEFAULT);
  expect(normalizeDiffContext(10)).toBe(10);
  for (const bad of [0, 2, 26, '3', null, undefined, 3.5]) expect(normalizeDiffContext(bad)).toBe(3);
  expect(stepDiffContext(3, 1)).toBe(5);
  expect(stepDiffContext(3, -1)).toBe(1);
  expect(stepDiffContext(1, -1)).toBeNull();
  expect(stepDiffContext(25, 1)).toBeNull();
});
