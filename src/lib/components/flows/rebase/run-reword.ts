import { activeSession, type Session } from '$lib/stores/session.svelte';
import { captureStores } from '$lib/stores/context';
// Reword execution: `rebase_interactive_start` [L] with the todo built by `buildRewordTodo`, after confirmation in
// `reword-dialog`. The dialog closes before the call (progress and cancellation in the base toolbar). A `DIRTY_WORKTREE`
// reopens the dialog in autostash retry mode, keeping the typed summary and description. On success the rewritten commit
// is selected again (its oid changed).
import { t } from '$i18n/index';
import { trackActivity } from '$lib/activity';
import { offerUndo } from '$lib/components/flows/undo/offer-undo';

import { commands } from '$lib/ipc/commands';
import type { TodoItem } from '$lib/ipc/types';

import { toast } from '$lib/stores/toast.svelte';
import { noteRebaseAutostash } from './autostash';
import { loadErrorText, startErrorText } from './rebase-state';

export interface RewordRun {
  /** Reworded commit (reopening after `DIRTY_WORKTREE`). */
  oid: string;
  /** Base of the rebase (parent of `oid`); `null` = `--root`. */
  upstream: string | null;
  /** HEAD seen by the preview: `STALE` if it moved. */
  expectedHead: string;
  todo: TodoItem[];
  /** Commits above `oid` (rewritten too): position of the new commit under the new HEAD. */
  later: number;
  /** Typed fields (kept for the reopening). */
  summary: string;
  body: string;
  autostash: boolean;
}

export function startReword(run: RewordRun, owner: Session = activeSession.current): Promise<boolean> {
  const { refs, repo, graph, runWrite, openDialog } = captureStores(owner);
  return trackActivity('rebase-reword', (async () => {
    const repoId = repo.id;
    if (repoId === null) return false;
    const stashesBefore = refs.stashes.length;
    const res = await runWrite(
      t('reword.op'),
      ({ opId }) =>
        commands.rebaseInteractiveStart({
          repoId, opId: opId!, upstream: run.upstream, expectedHead: run.expectedHead, todo: run.todo, autostash: run.autostash,
        }),
      {
        long: true,
        command: 'rebase_interactive_start',
        onError: (e) => {
          if (e.code === 'CANCELLED') {
            toast.info(t('rebase.cancelled.start'));
            return true;
          }
          if (e.code === 'DIRTY_WORKTREE' && !run.autostash) {
            void openDialog('reword-dialog', { oid: run.oid, retryAutostash: true, summary: run.summary, body: run.body });
            return true;
          }
          if (e.code === 'STALE') {
            // The base handler swallows `STALE { todo }` (silent reload by the caller): the dialog is already closed here.
            toast.error(t('reword.stale'));
            return true;
          }
          // A conflict, or the commit-msg hook refusing the new message: the banner of the base takes over.
          if (e.code === 'CONFLICT') return false;
          const text = startErrorText(e) ?? (e.code === 'INVALID_ARGUMENT' ? loadErrorText(e) : null);
          if (text !== null) {
            toast.error(text);
            return true;
          }
          return false;
        },
      },
    );
    if (!res.ok) return false;
    if (run.autostash) await noteRebaseAutostash(stashesBefore, false, owner);
    // The commit (and those above it) got new oids: select the rewritten one again.
    const rewritten = await rewrittenOid(repoId, run, res.value.head.oid, owner);
    if (rewritten) await graph.reveal(rewritten);
    else graph.clearSelection();
    await offerUndo(t('reword.done'), 'rebase', owner);
    return true;
  })());
}

/** New oid of the reworded commit: HEAD itself, otherwise the oldest commit of `upstream..HEAD` (the rebase kept the base). */
async function rewrittenOid(repoId: number, run: RewordRun, head: string | null, owner: Session): Promise<string | null> {
  if (run.later === 0) return head;
  const { reportError } = captureStores(owner);
  try {
    const p = await commands.rebaseTodoPreview({ repoId, upstream: run.upstream });
    return p.items.length === run.later + 1 ? (p.items[0]?.oid ?? null) : null;
  } catch (e) {
    reportError(e, { command: 'rebase_todo_preview', quiet: true });
    return null;
  }
}
