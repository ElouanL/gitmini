// Tags flow: create (`tag-create-dialog`), delete (undoable from the toast), push, and delete on a remote
// (`tag-remote-delete-dialog`, not undoable). Every write goes through `runWrite`; the answer's `RefsSnapshot` is
// applied, then `repo:changed` refreshes the rest.
import { t } from '$i18n/index';
import { trackActivity } from '$lib/activity';
import { hasDialog } from '$lib/dialogs/registry';
import { shortOid } from '$lib/format';
import { commands } from '$lib/ipc/commands';
import type { AppError } from '$lib/ipc/types';
import { captureStores } from '$lib/stores/context';
import { activeSession, type Session } from '$lib/stores/session.svelte';
import { toast } from '$lib/stores/toast.svelte';
import { fieldErrorMessage } from '../branches/names';
import { findLoadedRow } from '../branches/common';
import { offerUndo } from '../undo/offer-undo';
import { existsErrorMessage, planTagPush } from './tag-logic';

export interface CreateTagInput {
  name: string;
  /** Full oid of the commit to tag; `null` = HEAD (the backend resolves it). */
  target: string | null;
  /** Non-blank: the tag is annotated. */
  message: string;
}

/** `{ ok: true }` once created; otherwise `fieldError` is the text to show under the name field (`null`: already reported). */
export type CreateTagOutcome = { ok: true } | { ok: false; fieldError: string | null };

/** Label of the tagged commit in the dialog: `abc1234 summary`, or `HEAD (main)` when the tag goes on HEAD. */
export function tagTargetLabel(target: string | null, owner: Session = activeSession.current): string {
  const { repo } = captureStores(owner);
  if (target === null) {
    const head = repo.head;
    if (head?.detached) return t('tags.create.target.detached', { sha: shortOid(head.oid) });
    return t('tags.create.target.head', { name: head?.branch ?? 'HEAD' });
  }
  const row = findLoadedRow(target, owner);
  return row ? `${shortOid(target)} ${row.summary}` : shortOid(target);
}

/** Why a tag cannot be created now (no commit yet, or a write in flight); `null` if it can. */
export function createTagBlockReason(owner: Session = activeSession.current): string | null {
  const { op, repo } = captureStores(owner);
  if (repo.head?.unborn) return t('tags.create.noCommit');
  return op.blockReason('branch');
}

/** Opens `tag-create-dialog` on `target` (`null` = HEAD). */
export function openCreateTag(target: string | null, owner: Session = activeSession.current): Promise<unknown> {
  const { openDialog } = captureStores(owner);
  return openDialog('tag-create-dialog', { target });
}

export function createTag(input: CreateTagInput, owner: Session = activeSession.current): Promise<CreateTagOutcome> {
  const { openDialog, refs, repo, runWrite } = captureStores(owner);
  return trackActivity('tag-create', (async (): Promise<CreateTagOutcome> => {
    const repoId = repo.id;
    if (repoId === null) return { ok: false, fieldError: null };
    let fieldError: string | null = null;
    const flow: { identity: AppError | null } = { identity: null };
    const res = await runWrite(
      t('tags.op.create'),
      () => commands.tagCreate({ repoId, name: input.name, target: input.target, message: input.message.trim() || null }),
      {
        command: 'tag_create',
        data: { create: { name: input.name, target: input.target } },
        onError: (e) => {
          // An annotated tag needs a tagger identity: ask for it here, so the dialog can close once the tag exists.
          if (e.code === 'IDENTITY_MISSING' && hasDialog('identity-dialog')) {
            flow.identity = e;
            return true;
          }
          if (e.code === 'ALREADY_EXISTS' && e.details?.what === 'tag') {
            fieldError = existsErrorMessage(input.name, e.details);
            return true;
          }
          // Only the name is shown under its field; a refused target (gone, not a commit) goes to the toast.
          fieldError = fieldErrorMessage(e, ['name']);
          return fieldError !== null;
        },
      },
    );
    if (!res.ok) {
      if (flow.identity && (await openDialog<boolean>('identity-dialog', { error: flow.identity, command: 'tag_create' }))) {
        return createTag(input, owner);
      }
      return { ok: false, fieldError };
    }
    refs.apply(res.value);
    const created = res.value.tags.find((tag) => tag.name === input.name);
    toast.success(t('tags.create.done', { name: input.name, sha: shortOid(created?.targetOid ?? input.target ?? repo.head?.oid ?? '') }));
    return { ok: true };
  })());
}

/** Deletes a tag without confirmation: the toast offers the undo (10 s), which puts the tag back where it was. */
export function deleteTag(name: string, owner: Session = activeSession.current): Promise<boolean> {
  const { refs, repo, runWrite } = captureStores(owner);
  return trackActivity('tag-delete', (async () => {
    const repoId = repo.id;
    if (repoId === null) return false;
    const res = await runWrite(t('tags.op.delete'), () => commands.tagDelete({ repoId, name }), {
      command: 'tag_delete',
      data: { name },
      onError: (e) => gone(e, name, owner),
    });
    if (!res.ok) return false;
    refs.apply(res.value.refs);
    await offerUndo(t('tags.delete.done', { name }), 'tag-delete', owner);
    return true;
  })());
}

/** The tag vanished (deleted in a terminal) between the click and the command: say so and reread the refs. */
function gone(e: AppError, name: string, owner: Session): boolean {
  if (e.code !== 'NOT_FOUND' || e.details?.what !== 'ref') return false;
  toast.info(t('tags.error.gone', { name }));
  void captureStores(owner).refs.reloadRefs();
  return true;
}

/** `tag_push` [L] to a known remote: progress and cancel show in the toolbar. */
export function pushTagTo(name: string, remote: string, owner: Session = activeSession.current): Promise<boolean> {
  const { runWrite, session } = captureStores(owner);
  return trackActivity('tag-push', (async () => {
    const repoId = session.repoId;
    if (repoId === null) return false;
    const res = await runWrite(
      t('tags.op.push'),
      ({ opId }) => commands.tagPush({ repoId, opId: opId!, remote, name }),
      {
        long: true,
        command: 'tag_push',
        data: { name, remote },
        onError: (e) => {
          if (e.code === 'ALREADY_EXISTS' && e.details?.what === 'remote-tag') {
            toast.error(t('tags.push.exists', { name, remote }), { title: t('error.title.REJECTED_NON_FF') });
            return true;
          }
          return gone(e, name, owner);
        },
      },
    );
    if (!res.ok) return false;
    toast.success(t('tags.push.done', { name, remote }));
    return true;
  })());
}

/**
 * Pushes a tag: straight to the only remote, or after `tag-push-dialog` when there are several; with none, offers to add
 * one (as `push` does for a branch).
 */
export async function pushTag(name: string, owner: Session = activeSession.current): Promise<boolean> {
  const { refs, openDialog } = captureStores(owner);
  const plan = planTagPush(refs.remotes);
  if (plan.kind === 'none') {
    await openDialog('remote-add-dialog', {});
    return false;
  }
  if (plan.kind === 'single') return pushTagTo(name, plan.remote, owner);
  const remote = await openDialog<string>('tag-push-dialog', { name, remote: plan.remote });
  return remote ? pushTagTo(name, remote, owner) : false;
}

/**
 * `tag_push` with `delete` [L]: removes the tag from `remote`; the local tag stays. Nothing is recorded for the undo (the
 * confirmation said so), and no local ref changes, so the answer carries nothing to apply.
 */
export function deleteRemoteTagOn(name: string, remote: string, owner: Session = activeSession.current): Promise<boolean> {
  const { runWrite, session } = captureStores(owner);
  return trackActivity('tag-remote-delete', (async () => {
    const repoId = session.repoId;
    if (repoId === null) return false;
    const res = await runWrite(
      t('tags.op.remoteDelete'),
      ({ opId }) => commands.tagPush({ repoId, opId: opId!, remote, name, delete: true }),
      {
        long: true,
        command: 'tag_push',
        data: { name, remote, delete: true },
        onError: (e) => {
          if (e.code !== 'NOT_FOUND' || e.details?.what !== 'remote-tag') return false;
          toast.error(t('tags.remoteDelete.absent', { name, remote }));
          return true;
        },
      },
    );
    if (!res.ok) return false;
    toast.success(t('tags.remoteDelete.done', { name, remote }));
    return true;
  })());
}

/**
 * Deletes a tag on a remote after `tag-remote-delete-dialog`, which names the remote and the tag, asks which remote when
 * there are several, and warns that nothing can bring the tag back. With no remote there is nothing to delete on.
 */
export async function deleteRemoteTag(name: string, owner: Session = activeSession.current): Promise<boolean> {
  const { refs, openDialog } = captureStores(owner);
  const plan = planTagPush(refs.remotes);
  if (plan.kind === 'none') return false;
  const remote = await openDialog<string>('tag-remote-delete-dialog', { name, remote: plan.remote });
  return remote ? deleteRemoteTagOn(name, remote, owner) : false;
}
