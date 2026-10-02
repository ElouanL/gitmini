import { activeSession, type Session } from '$lib/stores/session.svelte';
import { captureStores } from '$lib/stores/context';
// Fetch, pull and push (10): IU decisions and calls IPC [L]. Replaces `git.push`, `git.pull`, `git.pullFfOnly`,
// `git.pullRebase` of the base (same id). Errors are routed by `handleError` (`runWrite`) to dedicated dialogs:
// `push-rejected-dialog`, `pull-diverged-dialog`, `pull-autostash-dialog`, `auth-required-dialog`.
import { t } from '$i18n/index';
import { fetchRemote } from '$lib/actions/builtin';
import { actionContext, type ActionContext } from '$lib/actions/registry';
import { confirmAction } from '$lib/dialogs/confirm';
import { hasDialog } from '$lib/dialogs/registry';
import { commands, type PullMode } from '$lib/ipc/commands';

import { toast } from '$lib/stores/toast.svelte';
import { offerUndo } from '../undo/offer-undo';
import { decidePush, forcePushMessage } from './remote-logic';

export interface PushArgs {
  remote: string;
  branch: string;
  remoteBranch?: string;
  setUpstream: boolean;
  forceWithLease: boolean;
  /** `Everything up-to-date` does not see itself in the answer (`void`): the caller knows if the branch was already published. */
  expectUpToDate?: boolean;
}

/** `remote_push` [L]. `data` accompanies the error up to `push-rejected-dialog` (remote and branch concerned). */
export async function pushRun(args: PushArgs, owner: Session = activeSession.current): Promise<boolean> {
  const { runWrite, session } = captureStores(owner);
  const repoId = session.repoId;
  if (repoId === null) return false;
  const { expectUpToDate, ...rest } = args;
  const res = await runWrite(
    t('remotes.op.push'),
    ({ opId }) => commands.remotePush({ repoId, opId: opId!, ...rest }),
    { long: true, command: 'remote_push', data: { remote: args.remote, branch: args.branch, remoteBranch: args.remoteBranch ?? args.branch } },
  );
  if (!res.ok) return false;
  toast.success(t(expectUpToDate ? 'remotes.toast.upToDate' : 'remotes.toast.pushDone'));
  return true;
}

/**
 * Push of `branchName` (default: current branch) according to 10 § Push table: detached → refusal, no remote → `remote-add-dialog`,
 * no upstream → `push-dialog`, `behind = 0` → push direct, `behind > 0 && ahead > 0` → UN `confirm-dialog[data-action=force-push]`
 * (N = `behind`) then `--force-with-lease`, `behind > 0 && ahead = 0` → toast "make a Pull".
 */
export async function pushBranch(ctx: ActionContext, branchName?: string): Promise<void> {
  const owner = ctx.session;
  const { openDialog } = captureStores(owner);
  const repoId = ctx.repoId;
  if (repoId === null) return;
  const name = branchName ?? ctx.repo.head?.branch ?? null;
  const branch = name ? (ctx.refs.snapshot?.local.find((b) => b.name === name) ?? null) : null;
  const decision = decidePush({ branch: name ? (branch ?? { name, upstream: null }) : null, remotes: ctx.refs.remotes });
  switch (decision.kind) {
    case 'detached':
      // From the toolbar the button is disabled; here: toast `DETACHED_HEAD` 10 §Cas error, with `branch-create-here-btn` .
      toast.error(t('remotes.toast.detached'), {
        title: t('error.title.DETACHED_HEAD'),
        actions: [
          {
            testid: 'branch-create-here-btn',
            label: t('error.createBranchHere'),
            run: () => void openDialog('branch-create-dialog', { startPoint: 'HEAD', checkout: true }),
          },
        ],
      });
      return;
    case 'no-remote':
      if (hasDialog('remote-add-dialog')) await openDialog('remote-add-dialog', {});
      else toast.error(t('toast.noRemote'));
      return;
    case 'dialog':
      await openDialog('push-dialog', { branch: name });
      return;
    case 'behind':
      toast.info(t('remotes.toast.behind', { ref: decision.ref }));
      return;
    case 'force': {
      // Only one confirmation dialog, with the number of commits replaced (: danger, focus on Cancel).
      const ok = await confirmAction({
        action: 'force-push',
        danger: true,
        title: t('remotes.forcePush.title'),
        message: forcePushMessage(decision.ref, decision.replaced),
        confirmLabel: t('remotes.forcePush.confirm'),
      }, owner);
      if (!ok) return;
      await pushRun({ remote: decision.remote, branch: name!, remoteBranch: decision.remoteBranch, setUpstream: false, forceWithLease: true }, owner);
      return;
    }
    case 'direct':
      await pushRun({
        remote: decision.remote,
        branch: name!,
        remoteBranch: decision.remoteBranch,
        setUpstream: false,
        forceWithLease: false,
        expectUpToDate: decision.upToDate,
      }, owner);
      return;
  }
}

export interface PullOptions {
  mode?: PullMode;
  autostash?: boolean;
}

/**
 * `remote_pull` [L]. Without `mode`, the backend solves it (`pull.rebase` local, otherwise the `pull.mode` setting). A pull that advanced the
 * branch is cancelable (`offerUndo`, Kind `pull`); an autostash stored in the stash is reported (10 §Pull 5).
 */
export async function pullRun(opts: PullOptions = {}, owner: Session = activeSession.current): Promise<boolean> {
  const { refs, repo, runWrite, session } = captureStores(owner);
  const repoId = session.repoId;
  if (repoId === null) return false;
  const before = repo.head?.oid ?? null;
  const stashBefore = opts.autostash ? (refs.stashes[0]?.oid ?? null) : null;
  const res = await runWrite(
    t('remotes.op.pull'),
    ({ opId }) =>
      commands.remotePull({
        repoId,
        opId: opId!,
        ...(opts.mode ? { mode: opts.mode } : {}),
        ...(opts.autostash ? { autostash: true } : {}),
      }),
    { long: true, command: 'remote_pull', data: { mode: opts.mode ?? null, autostash: opts.autostash === true } },
  );
  if (!res.ok) return false;
  if (opts.autostash) await announceKeptAutostash(repoId, stashBefore, owner);
  if (res.value.head.oid === before) toast.info(t('remotes.toast.upToDate'));
  else await offerUndo(t('remotes.toast.pullDone'), 'pull', owner);
  return true;
}

/** If the autostash did not reapply properly, git the guard: a new entry of stash appeared. */
async function announceKeptAutostash(repoId: number, stashBefore: string | null, owner: Session = activeSession.current): Promise<void> {
  const { refs } = captureStores(owner);
  try {
    const list = await commands.stashList({ repoId });
    refs.applyStashes(list);
    if (list[0] && list[0].oid !== stashBefore) toast.info(t('remotes.toast.stashKept'));
  } catch {
    // Comfort reading: `repo:changed { stash }` will refresh the list.
  }
}

export function pullCurrent(_ctx: ActionContext, mode?: PullMode): Promise<boolean> {
  const owner = _ctx.session;

  return pullRun(mode ? { mode } : {}, owner);
}

/** Fetch of a remote by its name (`push-rejected-fetch-btn`, adding a remote). Reuses the action of the base. */
export function fetchNamed(remote: string | null, owner: Session = activeSession.current): Promise<void> {

  return fetchRemote(actionContext(undefined, owner), remote);
}
