import { openDialog as dialog } from '../dialogs/registry';
// Capture once before awaiting: all results and retries belong to this repository.
import { graphFor } from './graph.svelte';
import { opFor } from './op.svelte';
import { refsFor } from './refs.svelte';
import { repoFor } from './repo.svelte';
import { activeSession, type Session } from './session.svelte';
import { statusFor } from './status.svelte';
import { uiFor } from './ui.svelte';
import { undoFor } from './undo.svelte';
import { wtFor } from '../components/wt/wt-state.svelte';
import { commitFormFor } from '../components/commit-form/form-state.svelte';
import { runWrite as write, type RunWriteOptions, type RunWriteContext } from './run-write';
import { reportError as report, type ErrorContext } from '../errors/report';

export function captureStores(owner: Session = activeSession.current) {
  const repoId = owner.repoId;
  return {
    session: owner, repo: repoFor(owner), graph: graphFor(owner), op: opFor(owner),
    refs: refsFor(owner), status: statusFor(owner), ui: uiFor(owner), undo: undoFor(owner),
    wt: wtFor(owner), commitForm: commitFormFor(owner),
    openDialog: <R = unknown>(id: string, props: Record<string, unknown> = {}) => dialog<R>(id, props, owner),
    runWrite: <T>(label: string, fn: (ctx: RunWriteContext) => Promise<T>, opts: RunWriteOptions = {}) =>
      write(label, fn, { ...opts, owner }),
    reportError: (error: unknown, ctx: ErrorContext = {}) => report(error, { ...ctx, repoId }),
  };
}
