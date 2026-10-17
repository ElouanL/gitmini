// Pure logic of the discarded files: how an entry reads in the list, and the texts of the restore and discard toasts.
import { t, tp } from '$i18n/index';
import { formatBytes } from '$lib/components/diff/diff-layout';
import { formatRelative } from '$lib/format';
import type { DiscardedFile } from '$lib/ipc/types';
import type { DiscardRestoreResult } from '$lib/ipc/commands';

/** `src/lib/a.ts` is `{ dir: 'src/lib', name: 'a.ts' }`; a file at the root has an empty `dir`. */
export function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? { dir: '', name: path } : { dir: path.slice(0, slash), name: path.slice(slash + 1) };
}

/** "512 B", "1.2 KiB": the size of the saved content. */
export function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : formatBytes(bytes);
}

/** The line under the file name: `Discarded · executable · 1.2 KiB · 2 minutes ago`. */
export function entryMeta(entry: Pick<DiscardedFile, 'source' | 'kind' | 'size' | 'time'>, now: number = Date.now()): string {
  const parts = [t(`trash.source.${entry.source}`)];
  if (entry.kind !== 'file') parts.push(t(`trash.kind.${entry.kind}`));
  parts.push(formatSize(entry.size), formatRelative(entry.time, now));
  return parts.join(' · ');
}

/** The toast after a restore: one file by name (and whether it replaced something), several by count. */
export function restoreMessage(result: Pick<DiscardRestoreResult, 'restored' | 'replaced'>): string {
  const [only] = result.restored;
  if (result.restored.length === 1 && only !== undefined) {
    return t(result.replaced.length > 0 ? 'trash.restore.done.replaced' : 'trash.restore.done', { path: only });
  }
  return tp('trash.restore.done.many', result.restored.length);
}

/** What a discard threw away, as the toast that follows it names it. */
export type DiscardAnnouncement =
  | { kind: 'files'; count: number }
  | { kind: 'all' }
  | { kind: 'hunk'; path: string };

export function announcementText(a: DiscardAnnouncement): string {
  if (a.kind === 'all') return t('trash.toast.all');
  if (a.kind === 'hunk') return t('trash.toast.hunk', { path: a.path });
  return tp('trash.toast.files', a.count);
}
