import { captureStores } from '../stores/context';
import { activeSession, type Session } from '../stores/session.svelte';
import { repo as workspace } from '../stores/repo.svelte';
// `handleError`: route each `AppError` according to the column "Action UI" of and titles of 03.
// Each rejection of `invoke` passes through here: an error is never swallowed.
//
// Order: 1. `ctx.onError`; 2. domain registered handlers (`registerErrorHandler`); 3. dedicated dialog
// recorded for this code; 4. behavior of the base (state, toast).
import { commands } from '../ipc/commands';
import type { AppError, ErrorCode, RepoOpState } from '../ipc/types';
import { toAppError } from '../ipc/transport';
import { hasDialog, openDialog } from '../dialogs/registry';
import { t } from '../../i18n/index';
import { app } from '../stores/app.svelte';
import { github } from '../stores/github.svelte';

import { toast, type ToastAction, type ToastDetails } from '../stores/toast.svelte';

import { setErrorSink, type ErrorContext } from './report';

export type { ErrorContext } from './report';

/** Domain Manager: Returns `true` if the error is supported (synchronous). */
export type ErrorHandler = (error: AppError, ctx: ErrorContext) => boolean;

const handlers = new Map<ErrorCode, ErrorHandler[]>();

/** Adds a manager for one or more codes; the most recent one passes first. Returns the withdrawal. */
export function registerErrorHandler(code: ErrorCode | ErrorCode[], handler: ErrorHandler): () => void {
  const codes = Array.isArray(code) ? code : [code];
  for (const c of codes) handlers.set(c, [handler, ...(handlers.get(c) ?? [])]);
  return () => {
    for (const c of codes) handlers.set(c, (handlers.get(c) ?? []).filter((h) => h !== handler));
  };
}

export function resetErrorHandlers(): void {
  handlers.clear();
}

// ── Utilitaires

function detailString(e: AppError, key: string): string | null {
  const v = e.details?.[key];
  return typeof v === 'string' ? v : null;
}

function detailStrings(e: AppError, key: string): string[] {
  const v = e.details?.[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function toastDetails(e: AppError): ToastDetails | undefined {
  const stderr = detailString(e, 'stderr');
  const args = detailStrings(e, 'args');
  if (!stderr && args.length === 0) return undefined;
  return { ...(stderr ? { stderr } : {}), ...(args.length ? { args } : {}) };
}

function titleOf(e: AppError): string {
  return t(`error.title.${e.code}`);
}

function showError(e: AppError, extra: { title?: string; message?: string; actions?: ToastAction[] } = {}): void {
  const details = toastDetails(e);
  toast.error(extra.message ?? e.message, {
    title: extra.title ?? titleOf(e),
    ...(details ? { details } : {}),
    ...(extra.actions?.length ? { actions: extra.actions } : {}),
  });
}

function retryAction(ctx: ErrorContext): ToastAction[] {
  const retry = ctx.retry;
  return retry ? [{ testid: 'toast-retry-btn', label: t('error.retry'), run: () => void retry() }] : [];
}

/** Dialogue dedicated to this code (if saved): Returns `true` if it has been opened. */
function openDedicated(id: string, e: AppError, ctx: ErrorContext, owner: Session): boolean {
  if (!hasDialog(id)) return false;
  void openDialog(id, {
    error: e,
    command: ctx.command,
    retry: ctx.retry,
    data: ctx.data,
  }, owner);
  return true;
}

const CHECKOUT_COMMANDS = new Set(['branch_checkout', 'branch_create']);
/** Commands that advance a status operation: `stash_save` is refused (BUSY { op-in-progress }). */
const CONTINUE_COMMANDS = new Set(['rebase_continue', 'rebase_skip', 'sequencer_continue', 'sequencer_skip', 'merge_continue']);

// ── Routage

function route(e: AppError, ctx: ErrorContext, owner: Session): void {
  const { repo, op, graph, status, undo, session, runWrite, openDialog } = captureStores(owner);
  // 1. Supported by the caller (error under a field...).
  if (ctx.onError?.(e) === true) return;

  // 2. Gestionnaires de domaine.
  for (const h of handlers.get(e.code) ?? []) if (h(e, ctx)) return;

  // 3 + 4. Socle.
  const quiet = ctx.quiet === true;
  switch (e.code) {
    case 'NOT_FOUND': {
      const what = detailString(e, 'what');
      if (what === 'workdir') {
        repo.markMissing(); // dedicated screen, never cascade toasts (ROB-08)
        return;
      }
      if (quiet) return;
      if (what === 'editor') {
        showError(e, {
          actions: [{ testid: 'toast-settings-btn', label: t('error.openSettings'), run: () => void openDialog('settings-dialog') }],
        });
        return;
      }
      if (what === 'upstream') {
        showError(e, { message: t('error.noUpstream') });
        return;
      }
      showError(e);
      return;
    }

    case 'CONFLICT': {
      const state = (e.details?.state ?? null) as RepoOpState | null;
      if (state) op.setState(state);
      graph.selectWip();
      void status.refresh();
      // No hook (no path in conflict): the error is also displayed.
      if (state && state.conflictedPaths.length === 0 && state.stopReason !== 'empty') {
        toast.error(e.message, { title: t('error.title.CONFLICT'), ...(toastDetails(e) ? { details: toastDetails(e)! } : {}) });
      }
      return;
    }

    case 'STALE': {
      const what = detailString(e, 'what');
      if (what === 'head' || what === 'undo') {
        void undo.peekNow();
        if (!quiet) showError(e, { message: what === 'undo' ? t('error.stale.undo') : t('error.stale.head') });
      } else {
        // cursor, diff, todo: silent charging by caller (`ctx.onError`); never toast.
        console.debug("[gitmini] out of date", e.details);
      }
      return;
    }

    case 'GIT_MISSING':
    case 'GIT_TOO_OLD':
      if (app.info && !app.info.gitError) app.info = { ...app.info, gitError: e.code };
      return;

    default:
      break;
  }

  if (quiet) return;

  switch (e.code) {
    case 'UNRESOLVED_CONFLICTS':
      showError(e);
      return;

    case 'DIRTY_WORKTREE': {
      if (ctx.command && CHECKOUT_COMMANDS.has(ctx.command) && openDedicated('checkout-dirty-dialog', e, ctx, owner)) return;
      if (ctx.command === 'remote_pull' && openDedicated('pull-autostash-dialog', e, ctx, owner)) return;
      const paths = detailStrings(e, 'paths');
      const retry = ctx.retry;
      const actions: ToastAction[] = [];
      // "Stash and try again" makes sense only out of operation in state: `stash_save` is refused during a rebase, a merge, a
      // cherry-pick or a revert (BUSY { op-in-progress }), and this is precisely the case of Continue / Skip.
      const canStash = retry !== undefined && op.state === null && !(ctx.command && CONTINUE_COMMANDS.has(ctx.command));
      if (retry && canStash) {
        actions.push({
          testid: 'toast-stash-retry-btn',
          label: t('error.stashAndRetry'),
          run: async () => {
            const repoId = session.repoId;
            if (repoId === null) return;
            const r = await runWrite(
              t('error.stashLabel'),
              () => commands.stashSave({ repoId, includeUntracked: true, keepIndex: false }),
              { command: 'stash_save' },
            );
            if (r.ok) await retry();
          },
        });
      }
      const lines = [e.message, ...paths, ...(canStash ? [] : [t('error.stageOrDiscard')])];
      showError(e, { message: lines.join('\n'), actions });
      return;
    }

    case 'UNTRACKED_WOULD_BE_OVERWRITTEN': {
      const paths = detailStrings(e, 'paths');
      showError(e, { message: paths.length ? `${e.message}\n${paths.join('\n')}` : e.message });
      return;
    }

    case 'IDENTITY_MISSING':
      if (hasDialog('identity-dialog')) {
        void openDialog<boolean>('identity-dialog', { error: e, command: ctx.command, retry: ctx.retry, data: ctx.data }).then(
          (saved) => {
            // Automatically restarting the order after the identity registration.
            if (saved) void ctx.retry?.();
          },
        );
        return;
      }
      showError(e);
      return;

    case 'AUTH_REQUIRED':
      if (e.details?.github === true) github.setLoggedOut();
      if (openDedicated('auth-required-dialog', e, ctx, owner)) return;
      showError(e);
      return;

    case 'REJECTED_NON_FF': {
      const operation = detailString(e, 'operation');
      if (operation === 'push' && openDedicated('push-rejected-dialog', e, ctx, owner)) return;
      if (operation === 'pull' && openDedicated('pull-diverged-dialog', e, ctx, owner)) return;
      showError(e);
      return;
    }

    case 'NOT_MERGED':
      if (openDedicated('branch-delete-force-dialog', e, ctx, owner)) return;
      showError(e);
      return;

    case 'BUSY': {
      const reason = detailString(e, 'reason');
      if (reason === 'op-in-progress') {
        const kind = (e.details?.state as RepoOpState | undefined)?.kind ?? op.state?.kind;
        showError(e, { message: kind ? t('error.busy.opInProgress', { kind: t(`op.kind.${kind}`) }) : e.message });
      } else if (reason === 'lock') {
        showError(e, {
          message: t('error.busy.lock', { file: detailString(e, 'lockFile') ?? '' }),
          actions: retryAction(ctx),
        });
      } else {
        showError(e);
      }
      return;
    }

    case 'CANCELLED':
      toast.info(t('error.cancelled'), { title: titleOf(e) });
      return;

    case 'DETACHED_HEAD':
      showError(e, {
        actions: [
          {
            testid: 'branch-create-here-btn',
            label: t('error.createBranchHere'),
            run: () => void openDialog('branch-create-dialog', { startPoint: 'HEAD', checkout: true }),
          },
        ],
      });
      return;

    case 'UNDO_UNAVAILABLE': {
      const reason = detailString(e, 'reason');
      showError(e, { message: reason ? undo.reasonText({ reason, entry: undo.entry }) : e.message });
      return;
    }

    case 'NOT_A_REPO':
    case 'UNSUPPORTED_REPO_FORMAT':
      // Off-opening from the reception (e.g. clone), the error remains visible.
      showError(e);
      return;

    default:
      // NETWORK, GIT_FAILED, ALREADY_EXISTS, INVALID_ARGUMENT, INDEX_CONFLICT, UNSUPPORTED_MERGES…
      showError(e);
  }
}

/**
 * Single input point for presenting an error. Normalizes to `AppError`, route, and returns it.
 * To call in the `catch` of any commands that are not passed by `runWrite`; `runWrite` already calls it.
 */
export function handleError(err: unknown, ctx: ErrorContext = {}): AppError {
  const e = toAppError(err);
  try {
    const owner = ctx.repoId == null ? activeSession.current :
      workspace.tabs.find((tab) => tab.repoId === ctx.repoId) ??
      (activeSession.current.repoId === ctx.repoId ? activeSession.current : null);
    if (!owner) return e; // A closed tab cannot mutate or prompt in the active repository.
    if (owner !== activeSession.current && !ctx.quiet) {
      owner.attention = true;
      // State updates remain immediate; interactive errors wait until their tab is active.
      const stateOnly = e.code === 'CONFLICT' || e.code === 'STALE' ||
        (e.code === 'NOT_FOUND' && e.details?.what === 'workdir');
      if (stateOnly) route(e, { ...ctx, quiet: true }, owner);
      const cancel = () => toast.dismiss(notification);
      const notification = toast.error(e.message, {
        title: owner.info?.name,
        actions: [{ testid: 'toast-view-repo-btn', label: t('tabs.view'), run: () => {
          if (!workspace.activate(owner)) return;
          owner.cancellations.delete(cancel);
          toast.dismiss(notification);
          if (!stateOnly) handleError(e, ctx);
        } }],
      });
      owner.cancellations.add(cancel);
      return e;
    }
    route(e, ctx, owner);
  } catch (inner) {
    console.error("[gitmini] error routing failed", inner, e);
    toast.error(e.message, { title: titleOf(e) });
  }
  return e;
}

/** Connect the complete router to `reportError` (called once on startup, and by testing). */
export function installErrorRouting(): void {
  setErrorSink((e, ctx) => {
    handleError(e, ctx);
  });
}
