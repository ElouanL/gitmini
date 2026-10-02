// Error routing (, column "Action IU" of; titles: 03 "In error cases").
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Component } from 'svelte';
import { registerDialog } from '../dialogs/registry';
import { dialogStack } from '../dialogs/stack.svelte';
import { messageKeys, t } from '../../i18n/index';
import { graph } from '../stores/graph.svelte';
import { op } from '../stores/op.svelte';
import { repo } from '../stores/repo.svelte';
import { session } from '../stores/session.svelte';
import { toast } from '../stores/toast.svelte';
import { createFakeTransport } from '../test/fake-transport';
import { makeConflictState, makeRepoInfo, makeStatus } from '../test/fixtures';
import { resetAll } from '../test/reset';
import { handleError, installErrorRouting, registerErrorHandler } from './handle';
import { reportError } from './report';
import type { AppError, ErrorCode } from '../ipc/types';

const err = (code: ErrorCode, details: Record<string, unknown> = {}, message = `msg ${code}`): AppError => ({ code, message, details });
// A Svelte component highways has at least one parameter ($$anchor): a function without a parameter would be taken for a lazy load.
const dummy = function dummy(_anchor: unknown) {} as unknown as Component<{ close: () => void }>;

beforeEach(() => {
  resetAll();
  installErrorRouting();
  createFakeTransport({ status_get: () => makeStatus(), undo_peek: () => ({ entry: null, available: false, reason: 'empty', head: null }) }).install();
  repo.info = makeRepoInfo();
  session.begin(1);
});

describe('titres de toast (03)', () => {
  const titled: [ErrorCode, Record<string, unknown>, string][] = [
    ['UNRESOLVED_CONFLICTS', {}, "Unresolved conflicts"],
    ['DIRTY_WORKTREE', { paths: ['a.txt'] }, "Local changes in progress"],
    ['UNTRACKED_WOULD_BE_OVERWRITTEN', { paths: ['a.txt'] }, "Untracked files would be overwritten"],
    ['NETWORK', {}, "Unreachable network"],
    ['GIT_FAILED', { stderr: 'boom', args: ['git', 'fetch'] }, "git failed"],
    ['NOT_FOUND', { what: 'path' }, "Not found"],
    ['ALREADY_EXISTS', { what: 'branch' }, "Invalid entry"],
    ['INVALID_ARGUMENT', { field: 'name' }, "Invalid entry"],
    ['BUSY', { reason: 'running' }, "Operation in progress"],
    ['DETACHED_HEAD', {}, "Detached HEAD"],
    ['UNDO_UNAVAILABLE', { reason: 'pushed', kind: 'commit' }, "Undo unavailable"],
  ];
  it.each(titled)("%s → toast error '%s'", (code, details, title) => {
    handleError(err(code, details));
    const last = toast.items[toast.items.length - 1]!;
    expect(last.kind).toBe(code === 'CANCELLED' ? 'info' : 'error');
    expect(last.title).toBe(title);
  });

  it("CANCELLED → toast information \"Operation canceled\"", () => {
    handleError(err('CANCELLED', { opId: 'x' }));
    expect(toast.items.at(-1)).toMatchObject({ kind: 'info', title: "Operation cancelled" });
  });

  it("each code of the catalogue has a title in the 18n", () => {
    const codes: ErrorCode[] = [
      'CONFLICT', 'UNRESOLVED_CONFLICTS', 'DIRTY_WORKTREE', 'UNTRACKED_WOULD_BE_OVERWRITTEN', 'INDEX_CONFLICT', 'AUTH_REQUIRED', 'REJECTED_NON_FF',
      'NETWORK', 'GIT_FAILED', 'IDENTITY_MISSING', 'NOT_FOUND', 'NOT_A_REPO', 'UNSUPPORTED_REPO_FORMAT', 'ALREADY_EXISTS', 'NOT_MERGED', 'BUSY',
      'CANCELLED', 'INVALID_ARGUMENT', 'STALE', 'DETACHED_HEAD', 'UNSUPPORTED_MERGES', 'UNDO_UNAVAILABLE', 'GIT_MISSING', 'GIT_TOO_OLD',
    ];
    expect(codes).toHaveLength(24);
    for (const c of codes) expect(messageKeys()).toContain(`error.title.${c}`);
  });

  it("GIT_FAILED : toast-details-btn has stderr and arguments", () => {
    handleError(err('GIT_FAILED', { exitCode: 1, stderr: 'fatal: nope', args: ['git', 'fetch'] }));
    expect(toast.items.at(-1)!.details).toEqual({ stderr: 'fatal: nope', args: ['git', 'fetch'] });
  });
});

describe("states and screens", () => {
  it("CONFLICT: no toast, operating state set, line WIP selected", () => {
    const state = makeConflictState();
    handleError(err('CONFLICT', { state }));
    expect(toast.items).toHaveLength(0);
    expect(op.state).toEqual(state);
    expect(graph.selection).toEqual({ kind: 'wip' });
  });

  it("CONFLICT without path in conflict (hook) and stop \"blocked\": toast error in addition", () => {
    handleError(err('CONFLICT', { state: makeConflictState({ conflictedPaths: [], phase: 'stopped', stopReason: 'blocked' }), stderr: 'hook' }));
    expect(toast.items.at(-1)).toMatchObject({ kind: 'error', title: "Operation interrupted" });
  });

  it("CONFLICT without path but empty: no toast", () => {
    handleError(err('CONFLICT', { state: makeConflictState({ conflictedPaths: [], phase: 'stopped', stopReason: 'empty' }) }));
    expect(toast.items).toHaveLength(0);
  });

  it("NOT_FOUND workdir : repo-missing-screen, never toast, even repeated (ROB-08)", () => {
    for (let i = 0; i < 5; i++) handleError(err('NOT_FOUND', { what: 'workdir' }));
    expect(repo.missing).toBe(true);
    expect(toast.items).toHaveLength(0);
  });

  it("NOT_FOUND upstream: dedicated text; NOT_FOUND editor: settings button", () => {
    handleError(err('NOT_FOUND', { what: 'upstream' }));
    expect(toast.items.at(-1)!.message).toBe("No upstream: push the branch with Set upstream");
    handleError(err('NOT_FOUND', { what: 'editor' }));
    expect(toast.items.at(-1)!.actions.map((a) => a.label)).toEqual(["Settings"]);
  });

  it('STALE cursor / diff / todo : silencieux ; head / undo : toast', () => {
    for (const what of ['cursor', 'diff', 'todo']) handleError(err('STALE', { what }));
    expect(toast.items).toHaveLength(0);
    handleError(err('STALE', { what: 'head' }));
    expect(toast.items.at(-1)).toMatchObject({ kind: 'error', title: "Expired data" });
  });

  it("BUSY op-in-progress / lock: texts of and toast-retry-btn on lock", () => {
    handleError(err('BUSY', { reason: 'op-in-progress', state: makeConflictState() }));
    expect(toast.items.at(-1)!.message).toBe("Finish or abort the current rebase first");
    const retry = vi.fn();
    handleError(err('BUSY', { reason: 'lock', lockFile: '/r/.git/index.lock' }), { retry });
    const last = toast.items.at(-1)!;
    expect(last.message).toContain('/r/.git/index.lock');
    expect(last.actions.map((a) => a.testid)).toEqual(['toast-retry-btn']);
    void last.actions[0]!.run();
    expect(retry).toHaveBeenCalledOnce();
  });

  it("BUSY lock : text of", () => {
    handleError(err('BUSY', { reason: 'lock', lockFile: '/r/.git/index.lock' }));
    expect(toast.items.at(-1)!.message).toBe("Another Git process is using this repository (/r/.git/index.lock). If no Git process is running, remove this file manually.");
  });

  it("DETACHED_HEAD : toast with branch-create-here-btn", () => {
    handleError(err('DETACHED_HEAD'));
    expect(toast.items.at(-1)!.actions.map((a) => a.testid)).toEqual(['branch-create-here-btn']);
  });

  it("UNDO_UNAVAILABLE : text of the motif (11)", () => {
    handleError(err('UNDO_UNAVAILABLE', { reason: 'pushed', kind: 'commit' }));
    expect(toast.items.at(-1)!.message).toBe("Cannot undo an operation that has already been published.");
  });
});

describe("dedicated dialogues (provided by areas)", () => {
  it("AUTH_REQUIRED, NOT_MERGED, REJECTED_NON_FF, DIRTY_WORKTREE: Open the saved dialog, without toast", () => {
    registerDialog('auth-required-dialog', dummy);
    registerDialog('branch-delete-force-dialog', dummy);
    registerDialog('push-rejected-dialog', dummy);
    registerDialog('pull-diverged-dialog', dummy);
    registerDialog('checkout-dirty-dialog', dummy);
    registerDialog('pull-autostash-dialog', dummy);

    handleError(err('AUTH_REQUIRED', { reason: 'credentials' }));
    handleError(err('NOT_MERGED', { name: 'x', commits: 3 }));
    handleError(err('REJECTED_NON_FF', { operation: 'push', stale: false }));
    handleError(err('REJECTED_NON_FF', { operation: 'pull', diverged: true }));
    handleError(err('DIRTY_WORKTREE', { paths: ['a'] }), { command: 'branch_checkout' });
    handleError(err('DIRTY_WORKTREE', { paths: ['a'] }), { command: 'remote_pull' });

    expect(dialogStack.entries.map((e) => e.id)).toEqual([
      'auth-required-dialog', 'branch-delete-force-dialog', 'push-rejected-dialog', 'pull-diverged-dialog', 'checkout-dirty-dialog', 'pull-autostash-dialog',
    ]);
    expect(toast.items).toHaveLength(0);
  });

  it("IDENTITY_MISSING: identity-dialog, then restart the command if the identity is registered", async () => {
    registerDialog('identity-dialog', dummy);
    const retry = vi.fn();
    handleError(err('IDENTITY_MISSING'), { retry });
    const entry = dialogStack.top!;
    expect(entry.id).toBe('identity-dialog');
    dialogStack.close(entry.key, true);
    await Promise.resolve();
    await Promise.resolve();
    expect(retry).toHaveBeenCalledOnce();
  });

  it("without recorded dialogue, the error remains visible (toast): never swallowed", () => {
    handleError(err('AUTH_REQUIRED', {}));
    handleError(err('IDENTITY_MISSING'));
    expect(toast.items).toHaveLength(2);
  });
});

describe("extension by areas", () => {
  it("ctx.onError takes hands first, then registerErrorHandler", () => {
    const seen: string[] = [];
    registerErrorHandler('INVALID_ARGUMENT', (e) => (seen.push(`domaine:${String(e.details?.field)}`), true));
    handleError(err('INVALID_ARGUMENT', { field: 'name' }));
    expect(seen).toEqual(['domaine:name']);
    expect(toast.items).toHaveLength(0);

    handleError(err('INVALID_ARGUMENT', { field: 'x' }), { onError: () => (seen.push('appelant'), true) });
    expect(seen).toEqual(['domaine:name', 'appelant']);
  });

  it("quiet: no toast, but state routing takes place", () => {
    handleError(err('NETWORK'), { quiet: true });
    expect(toast.items).toHaveLength(0);
    handleError(err('NOT_FOUND', { what: 'workdir' }), { quiet: true });
    expect(repo.missing).toBe(true);
  });

  it("reportError (used by stores) results in handleError", () => {
    reportError(new Error('inattendu'));
    expect(toast.items.at(-1)).toMatchObject({ kind: 'error', title: "git failed" });
  });

  it("the displayed error texts come from AppError.message", () => {
    handleError(err('NETWORK', {}, 'Impossible de joindre github.com'));
    expect(toast.items.at(-1)!.message).toBe('Impossible de joindre github.com');
    expect(t('error.title.NETWORK')).toBe("Unreachable network");
  });
});

describe("DIRTY_WORKTREE: \"Stasher and try again\" only when stash_save is possible", () => {
  const dirty = err('DIRTY_WORKTREE', { paths: ['a.txt', 'b.txt'] });

  it("Off operation: toast-stash-retry-btn (stash -u then restart command)", async () => {
    const fake = createFakeTransport({ stash_save: () => ({ created: null, list: [] }) }).install();
    const retry = vi.fn();
    handleError(dirty, { command: 'merge_branch', retry });
    const last = toast.items.at(-1)!;
    expect(last.actions.map((a) => a.testid)).toEqual(['toast-stash-retry-btn']);
    expect(last.message).toContain('a.txt');
    await last.actions[0]!.run();
    expect(fake.callsOf('stash_save')[0]!.args).toEqual({ repoId: 1, includeUntracked: true, keepIndex: false });
    expect(retry).toHaveBeenCalledOnce();
  });

  it.each(['rebase_continue', 'rebase_skip', 'sequencer_continue', 'sequencer_skip', 'merge_continue'])(
    "%s: no stash (BUSY op-in-progress), message \"index or cancel changes\"",
    (command) => {
      handleError(dirty, { command, retry: vi.fn() });
      const last = toast.items.at(-1)!;
      expect(last.actions).toEqual([]);
      expect(last.message).toContain("Stage or discard the affected changes");
    },
  );

  it("during a state operation (op.state not zero), regardless of the command: no stash", () => {
    op.setState(makeConflictState());
    handleError(dirty, { command: 'cherry_pick', retry: vi.fn() });
    expect(toast.items.at(-1)!.actions).toEqual([]);
    expect(toast.items.at(-1)!.message).toContain("Stage or discard the affected changes");
  });
});
