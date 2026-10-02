// Components testing aids from the working tree / diff / commit domain: repository open, status, transport dummy.
import { render } from '@testing-library/svelte';
import { installErrorRouting } from '$lib/errors';
import type { FileDiff, FileStatus, Hunk, RepoOpState, StatusSnapshot } from '$lib/ipc/types';
import { op } from '$lib/stores/op.svelte';
import { repo } from '$lib/stores/repo.svelte';
import { session } from '$lib/stores/session.svelte';
import { status } from '$lib/stores/status.svelte';
import { createFakeTransport, type FakeTransport, type Handler } from '$lib/test/fake-transport';
import { makeConflictState, makeRepoInfo, makeStatus } from '$lib/test/fixtures';
import { resetAll } from '$lib/test/reset';
import DialogHost from '../../dialogs-base/DialogHost.svelte';
import { commitForm } from '../../commit-form/form-state.svelte';
import { installWtErrorHandlers } from '../register';
import { wt } from '../wt-state.svelte';

export function file(path: string, over: Partial<FileStatus> = {}): FileStatus {
  return { path, oldPath: null, staged: null, unstaged: null, conflict: null, oldMode: null, newMode: null, submodule: null, nonUtf8: null, ...over };
}

export function snapshot(files: FileStatus[], over: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return makeStatus({ files, upstream: null, ahead: null, behind: null, truncated: false, ...over });
}

export function opState(over: Partial<RepoOpState> = {}): RepoOpState {
  return makeConflictState({ kind: 'merge', headName: 'refs/heads/main', onto: null, ontoLabel: null, incoming: 'feature', step: null, total: null, stoppedAt: null, currentSummary: null, conflictedPaths: [], ...over });
}

export function hunk(lines: [kind: 'ctx' | 'add' | 'del' | 'noeol', text: string, oldNo: number | null, newNo: number | null][], header = '@@ -1,3 +1,3 @@'): Hunk {
  return {
    header, oldStart: 1, oldLines: 3, newStart: 1, newLines: 3,
    lines: lines.map(([kind, text, oldNo, newNo]) => ({ kind, text, oldNo, newNo })),
  };
}

export function fileDiff(over: Partial<FileDiff> = {}): FileDiff {
  return {
    path: 'mod.txt', oldPath: null, oldMode: null, newMode: null, binary: false, tooLarge: null, oldSize: null, newSize: null, hunks: [],
    stats: { added: 0, removed: 0 }, hash: 'h1', submodule: null, lfsPointer: null, ...over,
  };
}

/** Sets everything to zero, opens a repository fake (id 1) and installs the fake transport. */
export function setup(handlers: Record<string, Handler> = {}, files: FileStatus[] = [], statusOver: Partial<StatusSnapshot> = {}): FakeTransport {
  resetAll({ keepRegistrations: true });
  wt.reset();
  commitForm.reset();
  installErrorRouting();
  installWtErrorHandlers();
  const fake = createFakeTransport({
    status_get: () => status.snapshot,
    undo_peek: () => ({ entry: null, available: false, reason: 'empty', head: null }),
    ...handlers,
  }).install();
  session.begin(1);
  repo.info = makeRepoInfo();
  op.setState(null);
  status.apply(snapshot(files, statusOver));
  return fake;
}

/** Mount the host of dialogues (confirmation of discard, identity...) and then the component. */
export function mountWithDialogs<P extends Record<string, unknown>>(component: Parameters<typeof render>[0], props?: P) {
  render(DialogHost);
  return render(component, props ? { props } : undefined);
}
