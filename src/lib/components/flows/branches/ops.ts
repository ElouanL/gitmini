import { activeSession, type Session } from '$lib/stores/session.svelte';
import { captureStores } from '$lib/stores/context';
// Branch scripts (06): deletion, checkout with autostash, creation. All go through `runWrite` (never
// The ANSWER `RefsSnapshot` is applied, and then `repo:changed` refreshes) and their releases by `handleError`.
import { t, tp } from '$i18n/index';
import { trackActivity } from '$lib/activity';
import { shortOid } from '$lib/format';
import { commands, type AutoStash, type CheckoutTarget } from '$lib/ipc/commands';
import type { AppError } from '$lib/ipc/types';

import { graph } from '$lib/stores/graph.svelte';

import { repo } from '$lib/stores/repo.svelte';

import { toast } from '$lib/stores/toast.svelte';
import { offerUndo } from '$lib/components/flows/undo/offer-undo';

const OID_RE = /^[0-9a-f]{40}$/;

/** Starting point text (`branch-create-start-point`): ref name, or `abc1234 summary` for a commit. */
export function startPointLabel(startPoint: string | null): string {
  if (startPoint === null || startPoint === 'HEAD') {
    const head = repo.head;
    if (head?.detached) return t('branches.create.startPoint.detached', { sha: shortOid(head.oid) });
    return t('branches.create.startPoint.head', { name: head?.branch ?? 'HEAD' });
  }
  if (OID_RE.test(startPoint)) {
    for (const page of graph.pages) {
      const row = page.rows.find((r) => r.oid === startPoint);
      if (row) return `${shortOid(startPoint)} ${row.summary}`;
    }
    return shortOid(startPoint);
  }
  return startPoint;
}

/** "the branch "x" or "the commit abc1234" (message of `checkout-dirty-dialog`). */
export function checkoutTargetLabel(target: CheckoutTarget): string {
  switch (target.kind) {
    case "local":
      return t('branches.checkout.target.branch', { name: target.name });
    case 'remote':
      return t('branches.checkout.target.branch', { name: target.localName ?? target.ref });
    case 'detached':
      return t('branches.checkout.target.detached', { sha: shortOid(target.oid) });
  }
}

/** Validates the `{ kind: … }` form of a checkout target received by `ctx.data`. */
export function asCheckoutTarget(v: unknown): CheckoutTarget | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { kind?: unknown; name?: unknown; ref?: unknown; oid?: unknown; localName?: unknown };
  if (o.kind === "local" && typeof o.name === 'string') return { kind: "local", name: o.name };
  if (o.kind === 'remote' && typeof o.ref === 'string') {
    return { kind: 'remote', ref: o.ref, ...(typeof o.localName === 'string' ? { localName: o.localName } : {}) };
  }
  if (o.kind === 'detached' && typeof o.oid === 'string') return { kind: 'detached', oid: o.oid };
  return null;
}

// ── Deleteession

/**
 * Removes a local branch. Without `force`, an unfused branch gives `NOT_MERGED`: `handleError` opens
 * `branch-delete-force-dialog` (which recalls `deleteBranch(name, true)`). The undo is offered with a 10 s toast.
 */
export function deleteBranch(name: string, force = false, owner: Session = activeSession.current): Promise<boolean> {
  const { refs, repo, runWrite } = captureStores(owner);
  return trackActivity('branch-delete', (async () => {
    const repoId = repo.id;
    if (repoId === null) return false;
    const res = await runWrite(t('branches.op.delete'), () => commands.branchDelete({ repoId, name, force }), {
      command: 'branch_delete',
      data: { name },
      onError: (e) => {
        if (e.code === 'NOT_FOUND' && e.details?.what === 'ref') {
          toast.info(t('branches.error.gone', { name }));
          void refs.reloadRefs();
          return true;
        }
        return false;
      },
    });
    if (!res.ok) return false;
    refs.apply(res.value.refs);
    await offerUndo(t('branches.delete.done', { name, sha: shortOid(res.value.deletedOid) }), 'branch-delete', owner);
    return true;
  })());
}

// "Autostash (checkout, creation with checkout) "
/** Rereads the list of stashes (updates the store `refs`); returns its length, `null` if the playback fails (already reported). */
export async function reloadStashCount(owner: Session = activeSession.current): Promise<number | null> {
  const { reportError, refs, repo } = captureStores(owner);
  const repoId = repo.id;
  if (repoId === null) return null;
  try {
    const list = await commands.stashList({ repoId });
    refs.applyStashes(list);
    return list.length;
  } catch (e) {
    reportError(e, { command: 'stash_list', quiet: true });
    return null;
  }
}

/**
 * After an autostash operation: `true` if the stashes list has grown (the stash created by autostash has not been depiled:
 * pop not requested, or reapply in conflict).
 */
export async function stashesGrew(stashesBefore: number, owner: Session = activeSession.current): Promise<boolean> {

  const after = await reloadStashCount(owner);
  return after !== null && after > stashesBefore;
}

/** After a checkout with autostash: warns if the stash has been stored. */
async function noteAutoStash(stashesBefore: number, reapply: boolean, owner: Session = activeSession.current): Promise<void> {

  if (await stashesGrew(stashesBefore, owner)) toast.info(t(reapply ? 'branches.checkoutDirty.conflict' : 'branches.checkoutDirty.kept'));
}

/** A `DIRTY_WORKTREE` despite autostash must not reopen the dialog: simple toast error. */
function noDirtyLoop(e: AppError): boolean {
  if (e.code !== 'DIRTY_WORKTREE') return false;
  toast.error(e.message);
  return true;
}

/** "Stash and switch" (`checkout-dirty-dialog`) for a checkout. */
export function checkoutWithAutoStash(target: CheckoutTarget, reapply: boolean, owner: Session = activeSession.current): Promise<boolean> {
  const { refs, repo, runWrite } = captureStores(owner);
  return trackActivity('checkout-autostash', (async () => {
    const repoId = repo.id;
    if (repoId === null) return false;
    const autoStash: AutoStash = { reapply };
    const before = refs.stashes.length;
    const res = await runWrite(t('branches.op.checkout'), () => commands.branchCheckout({ repoId, target, autoStash }), {
      command: 'branch_checkout',
      data: { target },
      onError: noDirtyLoop,
    });
    if (!res.ok) return false;
    refs.apply(res.value);
    await noteAutoStash(before, reapply, owner);
    return true;
  })());
}

export interface CreateArgs {
  name: string;
  startPoint: string | null;
}

/** Stash and switch for `branch_create { checkout: true }`. */
export function createWithAutoStash(args: CreateArgs, reapply: boolean, owner: Session = activeSession.current): Promise<boolean> {
  const { refs, repo, runWrite } = captureStores(owner);
  return trackActivity('branch-create-autostash', (async () => {
    const repoId = repo.id;
    if (repoId === null) return false;
    const before = refs.stashes.length;
    const res = await runWrite(
      t('branches.op.create'),
      () => commands.branchCreate({ repoId, name: args.name, startPoint: args.startPoint, checkout: true, autoStash: { reapply } }),
      { command: 'branch_create', data: { create: args }, onError: noDirtyLoop },
    );
    if (!res.ok) return false;
    refs.apply(res.value);
    await noteAutoStash(before, reapply, owner);
    return true;
  })());
}

/** Wording of the number of commits of a `NOT_MERGED` ("3 commits absent..."). */
export function notMergedMessage(name: string, commits: number): string {
  return tp('branches.deleteForce.message', commits, { name });
}
