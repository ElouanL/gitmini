import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import UpdateBanner from '../components/banner/UpdateBanner.svelte';
import SettingsDialog from '../components/settings/SettingsDialog.svelte';
import { updates } from './global.svelte';
import { app } from '../stores/app.svelte';
import { disabledStatus, type UpdateStatus } from '../ipc/updater';
import { resetAll } from '../test/reset';

function status(phase: UpdateStatus['phase'], extra: Partial<UpdateStatus> = {}): void {
  updates.view = { status: { ...disabledStatus(), enabled: true, reason: null, phase, version: '0.2.0', ...extra },
    countdown: null, deferred: false, installing: false };
}

beforeEach(() => {
  resetAll();
  app.load({});
  updates.view = { status: disabledStatus(), countdown: null, deferred: false, installing: false };
  vi.spyOn(updates, 'refresh').mockResolvedValue(undefined);
});
afterEach(() => { resetAll(); });

it('keeps unconfigured controls disabled and explains how the feature becomes available', () => {
  render(SettingsDialog, { close: vi.fn() });
  expect(screen.getByTestId('settings-updates-auto-checkbox')).toBeDisabled();
  expect(screen.getByTestId('settings-update-check-btn')).toBeDisabled();
  expect(screen.getByTestId('settings-update-status')).toHaveTextContent("are not yet configured");
});

it('renders release notes as text and allows a manual check when automation is off', async () => {
  status('available', { notes: '<img src=x onerror=alert(1)>\nNew release' });
  app.load({ 'updates.auto': false });
  const check = vi.spyOn(updates, 'check').mockResolvedValue(undefined);
  render(SettingsDialog, { close: vi.fn() });
  expect(screen.getByTestId('settings-update-notes')).toHaveTextContent('<img src=x onerror=alert(1)>');
  expect(screen.getByTestId('settings-update-notes').querySelector('img')).toBeNull();
  expect(screen.getByTestId('settings-updates-auto-checkbox')).not.toBeChecked();
  await fireEvent.click(screen.getByTestId('settings-update-check-btn'));
  expect(check).toHaveBeenCalledOnce();
});

it('shows download progress, a restart countdown and a working defer action', async () => {
  status('downloading', { downloaded: 50, total: 100 });
  render(UpdateBanner);
  expect(screen.getByTestId('update-progress')).toHaveAttribute('value', '50');
  status('downloading', { downloaded: 50, total: null });
  await tick();
  expect(screen.getByTestId('update-progress')).not.toHaveAttribute('value');
  status('ready');
  updates.view = { ...updates.view, countdown: 12 };
  await tick();
  expect(screen.getByRole('status')).toHaveTextContent("12 seconds");
  const defer = vi.spyOn(updates, 'defer').mockImplementation(() => {
    updates.view = { ...updates.view, countdown: null, deferred: true };
  });
  await fireEvent.click(screen.getByTestId('update-defer-btn'));
  expect(defer).toHaveBeenCalledOnce();
  expect(screen.queryByTestId('update-defer-btn')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent("postponed for this session");
});

it('hides the automatic banner when opted out and keeps the installation status visible', async () => {
  app.load({ 'updates.auto': false });
  status('ready');
  render(UpdateBanner);
  expect(screen.queryByTestId('update-banner')).not.toBeInTheDocument();
  status('installing');
  updates.view = { ...updates.view, installing: true };
  await tick();
  expect(screen.getByRole('status')).toHaveTextContent('Installing');
});
