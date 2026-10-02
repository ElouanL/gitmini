// Native folder selector (`dialog:open`, only plugin permission of WebView, ).
// Only file allowed to import @tauri-apps/plugin-dialog.
import { open } from '@tauri-apps/plugin-dialog';
import { hasTauri } from './transport';

/** Opens the native folder selector. `null` if the user cancels. Outside Tauri (browser Dev): Enter the path. */
export async function pickFolder(title?: string): Promise<string | null> {
  if (!hasTauri()) {
    const v = window.prompt(title ?? "Folder path");
    return v && v.trim() ? v.trim() : null;
  }
  const res = await open({ directory: true, multiple: false, title });
  return typeof res === 'string' ? res : null;
}
