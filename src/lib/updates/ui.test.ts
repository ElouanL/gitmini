import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import UpdateBanner from '../components/banner/UpdateBanner.svelte';
import SettingsDialog from '../components/settings/SettingsDialog.svelte';
import { updates } from './global.svelte';
import { initialView, type UpdateView } from './controller';
import { app } from '../stores/app.svelte';
import { disabledStatus, type UpdateStatus } from '../ipc/updater';
import { resetAll } from '../test/reset';

function status(phase: UpdateStatus['phase'], extra: Partial<UpdateStatus> = {}, view: Partial<UpdateView> = {}): void {
  updates.view = { ...initialView(), status: { ...disabledStatus(), enabled: true, reason: null, phase, version: '0.3.0', ...extra }, ...view };
}

beforeEach(() => {
  resetAll();
  app.load({});
  updates.view = initialView();
  vi.spyOn(updates, 'refresh').mockResolvedValue(undefined);
});
afterEach(() => { resetAll(); });

it('keeps unconfigured controls disabled and explains how the feature becomes available', () => {
  render(SettingsDialog, { close: vi.fn() });
  expect(screen.getByTestId('settings-updates-auto-checkbox')).toBeDisabled();
  expect(screen.getByTestId('settings-update-check-btn')).toBeDisabled();
  expect(screen.queryByTestId('settings-update-install-btn')).not.toBeInTheDocument();
  expect(screen.getByTestId('settings-update-status')).toHaveTextContent("are not yet configured");
});

it('renders release notes as text and allows a manual check when the automatic check is off', async () => {
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

it('offers the Update button in the settings once a version is known', async () => {
  status('available');
  const update = vi.spyOn(updates, 'update').mockResolvedValue(undefined);
  render(SettingsDialog, { close: vi.fn() });
  expect(screen.getByTestId('settings-update-status')).toHaveTextContent('Version 0.3.0 is available');
  await fireEvent.click(screen.getByTestId('settings-update-install-btn'));
  expect(update).toHaveBeenCalledOnce();
});

it('announces an available version with a button that updates, even with the automatic check off', async () => {
  app.load({ 'updates.auto': false });
  status('available');
  const update = vi.spyOn(updates, 'update').mockResolvedValue(undefined);
  render(UpdateBanner);
  expect(screen.getByRole('status')).toHaveTextContent('Version 0.3.0 is available');
  await fireEvent.click(screen.getByTestId('update-now-btn'));
  expect(update).toHaveBeenCalledOnce();
});

it('shows download progress and then the installation, without buttons that would interrupt them', async () => {
  status('downloading', { downloaded: 50, total: 100 });
  render(UpdateBanner);
  expect(screen.getByTestId('update-progress')).toHaveAttribute('value', '50');
  expect(screen.queryByTestId('update-now-btn')).not.toBeInTheDocument();
  status('downloading', { downloaded: 50, total: null });
  await tick();
  expect(screen.getByTestId('update-progress')).not.toHaveAttribute('value');
  status('installing', {}, { installing: true });
  await tick();
  expect(screen.getByRole('status')).toHaveTextContent('Installing');
  expect(screen.queryByTestId('update-now-btn')).not.toBeInTheDocument();
  expect(screen.queryByTestId('update-defer-btn')).not.toBeInTheDocument();
});

it('lets the user postpone the banner, which stays reachable from the settings', async () => {
  status('available');
  const defer = vi.spyOn(updates, 'defer').mockImplementation(() => { updates.view = { ...updates.view, deferred: true }; });
  render(UpdateBanner);
  await fireEvent.click(screen.getByTestId('update-defer-btn'));
  expect(defer).toHaveBeenCalledOnce();
  await tick();
  expect(screen.queryByTestId('update-banner')).not.toBeInTheDocument();
  render(SettingsDialog, { close: vi.fn() });
  expect(screen.getByTestId('settings-update-install-btn')).toBeInTheDocument();
});

it('says why nothing happened when the update is blocked by pending work', () => {
  status('available', {}, { blocked: true });
  render(UpdateBanner);
  expect(screen.getByRole('status')).toHaveTextContent('Finish the running operation or your commit message first');
});

it('offers to try again after a failed update, but stays silent about a failed background check', async () => {
  status('error', { error: { code: 'DOWNLOAD', message: 'connection reset' } }, { failed: false });
  render(UpdateBanner);
  expect(screen.queryByTestId('update-banner')).not.toBeInTheDocument();
  status('error', { error: { code: 'DOWNLOAD', message: 'connection reset' } }, { failed: true });
  await tick();
  expect(screen.getByRole('status')).toHaveTextContent('Unable to update: connection reset');
  const update = vi.spyOn(updates, 'update').mockResolvedValue(undefined);
  expect(screen.getByTestId('update-now-btn')).toHaveTextContent('Try again');
  await fireEvent.click(screen.getByTestId('update-now-btn'));
  expect(update).toHaveBeenCalledOnce();
});
