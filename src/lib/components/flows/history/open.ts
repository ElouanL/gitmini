// Opening the file history from anywhere (diff header, file menus, palette). Light on purpose: it imports no component, so
// a caller does not pull the view's chunk until the view is actually opened.
import type { DiffSource, FileStatus } from '$lib/ipc/types';
import { ui } from '$lib/stores/ui.svelte';
import { historyPathOf } from './history-logic';
import { FILE_HISTORY_VIEW } from './ids';

export type HistoryMode = 'changes' | 'blame';

/** What the view is told through `ui.openCenter`. */
export interface FileHistoryProps {
  path: string;
  /** Commit (or ref) to list the history from; absent or `null`: HEAD. */
  rev?: string | null;
  mode?: HistoryMode;
}

export function openFileHistory(path: string, opts: { rev?: string | null; mode?: HistoryMode } = {}): void {
  const props: FileHistoryProps = { path, rev: opts.rev ?? null, mode: opts.mode ?? 'changes' };
  ui.openCenter(FILE_HISTORY_VIEW, props as unknown as Record<string, unknown>);
}

/**
 * The name the history of an open diff's file is read under. A working-tree diff goes by the name the file has in HEAD (the
 * old name of a renamed file, as for the file menus), `null` when it has no commit yet; a commit or range diff goes by its own
 * `path`, the name in that commit. `entry`: the diff's file in the status, when it is listed.
 */
export function diffHistoryPath(kind: DiffSource['kind'] | undefined, path: string, entry: Parameters<typeof historyPathOf>[0] | null): string | null {
  const workingTree = kind === 'unstaged' || kind === 'staged' || kind === 'conflict';
  return workingTree && entry !== null ? historyPathOf(entry) : path;
}

/** The file the center view is about. */
export interface CurrentFile {
  /** The name to open its history under; `null` for a working-tree file that has no commit yet. */
  path: string | null;
  rev: string | null;
  view: 'diff' | 'file-history';
}

/** The file the center view is about: the open diff's, or the history view's own. `null` when the graph is showing. */
export function currentFile(files: readonly FileStatus[]): CurrentFile | null {
  const v = ui.centerView;
  const props = v.props as { path?: unknown; rev?: unknown; source?: { kind?: DiffSource['kind']; oid?: unknown } };
  if (typeof props.path !== 'string' || props.path === '') return null;
  if (v.id === FILE_HISTORY_VIEW) return { path: props.path, rev: typeof props.rev === 'string' ? props.rev : null, view: 'file-history' };
  if (v.id === 'diff') {
    const source = props.source;
    const rev = source?.kind === 'commit' && typeof source.oid === 'string' ? source.oid : null;
    const path = props.path;
    return { path: diffHistoryPath(source?.kind, path, files.find((f) => f.path === path) ?? null), rev, view: 'diff' };
  }
  return null;
}
