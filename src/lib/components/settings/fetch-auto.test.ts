// Settings: the "Fetch automatically" choice (`fetch.auto`), keyboard-operable like the other selects.
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { whenIdle } from '../../activity';
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

it('is off by default and lists the choices in order, each with a readable label', () => {
  render(SettingsDialog, { close: vi.fn() });
  const select = screen.getByTestId<HTMLSelectElement>('settings-fetch-auto-select');
  expect(select.value).toBe('0');
  expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
    ['0', 'Never'], ['5', 'Every 5 minutes'], ['15', 'Every 15 minutes'], ['30', 'Every 30 minutes'],
  ]);
  expect(screen.getByLabelText('Fetch automatically')).toBe(select);
  expect(select).toHaveAccessibleDescription(/never asks for a password/);
});

it('reflects the saved interval', () => {
  app.load({ 'fetch.auto': 15 });
  render(SettingsDialog, { close: vi.fn() });
  expect(screen.getByTestId<HTMLSelectElement>('settings-fetch-auto-select').value).toBe('15');
});

it('saves the choice as a number of minutes, and 0 for never', async () => {
  render(SettingsDialog, { close: vi.fn() });
  const select = screen.getByTestId('settings-fetch-auto-select');
  await userEvent.selectOptions(select, '5');
  expect(app.get('fetch.auto')).toBe(5);
  await whenIdle();
  await userEvent.selectOptions(select, '0');
  await whenIdle();
  expect(fake.callsOf('settings_set').map((c) => c.args)).toEqual([
    { key: 'fetch.auto', value: 5 },
    { key: 'fetch.auto', value: 0 },
  ]);
});

it('is a native select reached by Tab in the order of the form, so the keyboard needs nothing special', async () => {
  render(SettingsDialog, { close: vi.fn() });
  const select = screen.getByTestId('settings-fetch-auto-select');
  expect(select.tagName).toBe('SELECT');
  expect(select).toBeEnabled();
  expect(select.tabIndex).toBe(0);
  screen.getByTestId('settings-pull-mode-select').focus();
  await userEvent.tab();
  expect(select).toHaveFocus();
});

it('goes back to the previous value when the backend refuses the new one', async () => {
  fake.on('settings_set', () => { throw { code: 'INVALID_ARGUMENT', message: 'no', details: { field: 'value' } }; });
  render(SettingsDialog, { close: vi.fn() });
  await userEvent.selectOptions(screen.getByTestId('settings-fetch-auto-select'), '30');
  await whenIdle();
  expect(app.get('fetch.auto')).toBe(0);
});
