import { Channel, invoke } from '@tauri-apps/api/core';
import { getTransport } from './transport';

export interface UpdateError { code: string; message: string }
export interface UpdateStatus {
  enabled: boolean;
  reason: string | null;
  phase: 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'up-to-date' | 'error';
  version: string | null;
  notes: string | null;
  error: UpdateError | null;
  downloaded: number;
  total: number | null;
}
export const disabledStatus = (reason = 'unconfigured'): UpdateStatus => ({
  enabled: false, reason, phase: 'disabled', version: null, notes: null, error: null, downloaded: 0, total: null,
});

export interface UpdaterApi {
  status(): Promise<UpdateStatus>;
  check(): Promise<UpdateStatus>;
  download(progress: (status: UpdateStatus) => void): Promise<UpdateStatus>;
  install(): Promise<void>;
}

export function updaterAvailable(e2e = false): boolean {
  return !import.meta.env.DEV && !e2e && getTransport().kind === 'tauri';
}

// Separate desktop interface: never send updater commands to the HTTP development bridge.
export const updaterApi: UpdaterApi = {
  status: () => updaterAvailable() ? invoke('app_update_status') : Promise.resolve(disabledStatus('development')),
  check: () => invoke('app_update_check'),
  download(progress) {
    const onProgress = new Channel<UpdateStatus>();
    onProgress.onmessage = progress;
    return invoke('app_update_download', { onProgress });
  },
  install: () => invoke('app_update_install'),
};
