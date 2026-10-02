// `runWrite(label, fn)`: envelope of any writing command (, 03 "Writing Lock").
// - a flight write disables others (store `op`): a second call is denied locally by `BUSY`, without IPC;
// - no optimistic updates: we wait for the answer, then `repo:changed` refreshes the stores;
// - a rejection passes through `handleError` (never swallowed) and is returned to the appellant in `{ ok: false, error }`.
import type { AppError } from '../ipc/types';
import { newOpId } from '../ipc/commands';
import { reportError, type ErrorContext } from '../errors/report';
import { t } from '../../i18n/index';
import { opFor } from './op.svelte';
import { activeSession, type Session } from './session.svelte';

export interface RunWriteContext {
  /** UUID v4 of the command [L] (`long: true`), if not `null`. To go to `commands.remote*` / `rebase*`. */
  opId: string | null;
}

export interface RunWriteOptions {
  owner?: Session;
  /** Undoable command [L]: generates a `opId`, displays `toolbar-op-progress` and `toolbar-op-cancel-btn`. */
  long?: boolean;
  /** Main IPC command (snake_case): refines error routing (`DIRTY_WORKTREE`, `REJECTED_NON_FF`...). */
  command?: string;
  /** Supported error before any dialog or toast (error under a field...): return `true`. */
  onError?: ErrorContext['onError'];
  /** Data transmitted to dedicated dialogues. */
  data?: ErrorContext['data'];
  /** No toast error (state routing still takes place). */
  quiet?: boolean;
}

export type RunResult<T> = { ok: true; value: T } | { ok: false; error: AppError };

export async function runWrite<T>(
  label: string,
  fn: (ctx: RunWriteContext) => Promise<T>,
  opts: RunWriteOptions = {},
): Promise<RunResult<T>> {
  const owner = opts.owner ?? activeSession.current;
  if (owner.closed) return { ok: false, error: { code: 'NOT_FOUND', message: "Closed repository", details: { what: 'repo' } } };
  const op = opFor(owner);
  const retry = () => runWrite(label, fn, { ...opts, owner });
  const ctx: ErrorContext = {
    repoId: owner.repoId,
    ...(opts.command ? { command: opts.command } : {}),
    retry,
    ...(opts.onError ? { onError: opts.onError } : {}),
    ...(opts.data ? { data: opts.data } : {}),
    ...(opts.quiet ? { quiet: true } : {}),
  };

  const running = op.inflight;
  if (running) {
    const error: AppError = {
      code: 'BUSY',
      message: t('op.inflight', { label: running.label }),
      details: { reason: 'running', runningLabel: running.label, ...(running.opId ? { runningOpId: running.opId } : {}) },
    };
    reportError(error, ctx);
    return { ok: false, error };
  }

  const opId = opts.long ? newOpId() : null;
  const end = op.begin(label, opId);
  try {
    const value = await fn({ opId });
    return { ok: true, value };
  } catch (e) {
    const error = reportError(e, ctx);
    return { ok: false, error };
  } finally {
    end();
  }
}
