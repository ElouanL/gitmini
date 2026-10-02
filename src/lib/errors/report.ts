// Error sheet entry point: stores call `reportError`; the complete router (`handleError`, in
// ./handle.ts) plugs in to boot. Avoids stores import cycles.
import type { AppError } from '../ipc/types';
import { toAppError } from '../ipc/transport';

export interface ErrorContext {
  /** Originating tab, independent of the active project. */
  repoId?: number | null;
  /** IPC command involved (snake_case): refine routing (`DIRTY_WORKTREE` does not open in the same dialog for a checkout and a pull). */
  command?: string;
  /** Relaunch the same command with the same arguments (`toast-retry-btn`, restart after `identity-dialog`...). */
  retry?: () => unknown;
  /** Called first: return `true` = supported error (no dialog or toast). To display the error under a field. */
  onError?: (error: AppError) => boolean | void;
  /** Free data transmitted to dedicated dialogs (e.g. `{ name }` of a branch). */
  data?: Record<string, unknown>;
  /** No toast for this error (silent refreshments), but state routing (CONFLICT, workdir...) takes place. */
  quiet?: boolean;
}

export type ErrorSink = (error: AppError, ctx: ErrorContext) => void;

let sink: ErrorSink = (error) => console.error("[gitmini] unrouted error", error);

export function setErrorSink(s: ErrorSink): void {
  sink = s;
}

/** Route an error to `handleError` (once connected). Returns the standard `AppError`. */
export function reportError(err: unknown, ctx: ErrorContext = {}): AppError {
  const e = toAppError(err);
  sink(e, ctx);
  return e;
}
