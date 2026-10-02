import { activeSession, type Session } from '$lib/stores/session.svelte';
import { captureStores } from '$lib/stores/context';
// Remote management and opening of a PR (10 §Remote management, §Open a PR).
import { t } from '$i18n/index';
import { confirmAction } from '$lib/dialogs/confirm';

import { commands } from '$lib/ipc/commands';
import type { RemoteInfo } from '$lib/ipc/types';

import { toast } from '$lib/stores/toast.svelte';
import { remoteRemoveMessage, remoteTrackingCount } from './remote-logic';

/**
 * Remove a remote after `confirm-dialog[data-action=remote-remove]` whose text includes the removed tracking branches
 * (: no red danger, no recovery from gitmini). `git remote remove` also removes the relevant `branch.*.remote/merge`.
 */
export async function removeRemote(remote: Pick<RemoteInfo, 'name'>, owner: Session = activeSession.current): Promise<boolean> {
  const { refs, runWrite, session } = captureStores(owner);
  const repoId = session.repoId;
  if (repoId === null) return false;
  const ok = await confirmAction({
    action: 'remote-remove',
    title: t('remotes.remove.title'),
    message: remoteRemoveMessage(remote.name, remoteTrackingCount(refs.snapshot, remote.name)),
    confirmLabel: t('remotes.remove.confirm'),
  }, owner);
  if (!ok) return false;
  const res = await runWrite(t('remotes.op.remoteRemove'), () => commands.remoteRemove({ repoId, name: remote.name }), {
    command: 'remote_remove',
  });
  if (!res.ok) return false;
  void refs.reloadRemotes();
  void refs.reloadRefs();
  toast.success(t('remotes.toast.remoteRemoved', { name: remote.name }));
  return true;
}

/** `github_open_pr`: the backend opens `…/compare/<branche>?expand=1` by the path of `open_external` (no writing, no lock). */
export async function openPullRequest(branch: string, owner: Session = activeSession.current): Promise<boolean> {
  const { reportError, session } = captureStores(owner);
  const repoId = session.repoId;
  if (repoId === null) return false;
  try {
    await commands.githubOpenPr({ repoId, branch });
    toast.info(t('remotes.toast.prOpened'));
    return true;
  } catch (e) {
    // `NOT_FOUND { what: "remote-branch" | "github-remote" }`: toast with the backend message.
    reportError(e, { command: 'github_open_pr' });
    return false;
  }
}
