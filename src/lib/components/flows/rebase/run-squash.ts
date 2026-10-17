import { activeSession, type Session } from '$lib/stores/session.svelte';
import { captureStores } from '$lib/stores/context';
// Squash execution: `rebase_interactive_start` [L] with the todo built by `buildSquashTodo`, after confirmation in
// `squash-dialog`. The dialog closes before the call (progress and cancellation in the base toolbar). A `DIRTY_WORKTREE`
// reopens the dialog in autostash retry mode, keeping the typed message.
import { t, tp } from '$i18n/index';
import { trackActivity } from '$lib/activity';
import { offerUndo } from '$lib/components/flows/undo/offer-undo';

import { commands } from '$lib/ipc/commands';
import type { TodoItem } from '$lib/ipc/types';

import { toast } from '$lib/stores/toast.svelte';
import { noteRebaseAutostash } from './autostash';
import { loadErrorText, startErrorText } from './rebase-state';

export interface SquashRun {
  /** Selected commits (graph selection order is irrelevant): reopening after `DIRTY_WORKTREE`. */
  oids: string[];
  /** Base of the rebase; `null` = `--root`. */
  upstream: string | null;
  /** HEAD seen by the preview: `STALE` if it moved. */
  expectedHead: string;
  todo: TodoItem[];
  /** Final message (also kept for the reopening). */
  message: string;
  autostash: boolean;
}

export function startSquash(run: SquashRun, owner: Session = activeSession.current): Promise<boolean> {
  const { refs, repo, graph, runWrite, openDialog } = captureStores(owner);
  return trackActivity('rebase-squash', (async () => {
    const repoId = repo.id;
    if (repoId === null) return false;
    const stashesBefore = refs.stashes.length;
    const res = await runWrite(
      t('rebase.op.squash'),
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
            void openDialog('squash-dialog', { oids: run.oids, retryAutostash: true, message: run.message });
            return true;
          }
          if (e.code === 'STALE') {
            // The base handler swallows `STALE { todo }` (silent reload by the caller): the dialog is already closed here.
            toast.error(t('rebase.squash.stale'));
            return true;
          }
          if (e.code === 'CONFLICT') return false; // the banner of the base takes over
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
    // The selected commits no longer exist.
    graph.clearSelection();
    await offerUndo(tp('rebase.squash.done', run.oids.length), 'rebase', owner);
    return true;
  })());
}
