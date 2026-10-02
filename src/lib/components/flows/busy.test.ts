// BUSY { reason: "op-in-progress" } during a rebase, a merge, a cherry-pick or a revert (, 06/07/09 "In error case")
// for the actions of A streams: menus and actions disabled while the operation is in progress; if the backend still refuses
// (operation launched in terminal and not yet seen), toast "Complete or abandon the current <kind> first", git unlaunched.
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { whenIdle } from '$lib/activity';
import { actionDisabledReason, getAction } from '$lib/actions/registry';
import { checkoutTarget } from '$lib/actions/checkout';
import DialogHost from '$lib/components/dialogs-base/DialogHost.svelte';
import '$lib/components/dialogs-base/register';
import { openDialog, preloadDialog } from '$lib/dialogs/registry';
import type { OpKind } from '$lib/ipc/types';
import { graph } from '$lib/stores/graph.svelte';
import { resolveMenu } from '$lib/menus/registry';
import { op } from '$lib/stores/op.svelte';
import { toast } from '$lib/stores/toast.svelte';
import { makeBranch, makeConflictState, oid as fxOid } from '$lib/test/fixtures';
import { resetAll } from '$lib/test/reset';
import { openTestRepo, oid } from './test-support';
import '$lib/register-core';
import './branches/register';
import './merge/register';
import './pick/register';
import './rebase/register';
import { registerBranchErrorHandlers } from './branches/errors';
import { registerPickErrorHandlers } from './pick/errors';
import { runPick } from './pick/run';
import { startRebase } from './rebase/run';

const KINDS: Exclude<OpKind, 'am'>[] = ['rebase', 'merge', 'cherry-pick', 'revert'];
const stateOf = (kind: OpKind) => makeConflictState({ kind, headName: 'refs/heads/main' });
const busy = (kind: OpKind) => () => {
  throw { code: 'BUSY', message: "occupied", details: { reason: 'op-in-progress', state: stateOf(kind) } };
};
const expected = (kind: OpKind) => `Finish or abort the current ${kind} first`;

// The dialogues are in lazy loading: they are downloaded once (the first dynamic import of a chunk is slow under vitest).
beforeAll(async () => {
  await Promise.all(['merge-dialog', 'branch-create-dialog', 'branch-delete-force-dialog'].map((id) => preloadDialog(id)));
}, 30_000);

beforeEach(() => {
  resetAll({ keepRegistrations: true });
  registerBranchErrorHandlers();
  registerPickErrorHandlers();
});

describe.each(KINDS)('pendant un %s in progress', (kind) => {
  it("menus and actions of A streams disabled (nothing is started)", async () => {
    await openTestRepo();
    op.setState(stateOf(kind));
    const disabled = (menu: ReturnType<typeof resolveMenu>, id: string) => menu.find((i) => i.id === id)?.disabled;
    const branchMenu = resolveMenu({ menu: 'branch', branch: makeBranch('feature', 5) });
    for (const id of ['merge', 'rebase-onto', 'interactive-rebase-onto', 'delete']) expect(disabled(branchMenu, id), `branch/${id}`).toBe(true);
    // `rebase-onto` is hidden for an ancestor of HEAD, `interactive-rebase` for a commit out of HEAD: two commits.
    const ancestor = resolveMenu({ menu: 'commit', oid: fxOid(50), oids: [fxOid(50)] });
    for (const id of ['cherry-pick', 'revert', 'interactive-rebase']) expect(disabled(ancestor, id), `commit/${id}`).toBe(true);
    const stranger = '0'.repeat(37) + '3e7';
    expect(disabled(resolveMenu({ menu: 'commit', oid: stranger, oids: [stranger] }), 'rebase-onto'), 'commit/rebase-onto').toBe(true);
    graph.selectCommits([fxOid(50)]);
    for (const id of ['drag.rebase', 'drag.merge', 'pick.cherry-pick', 'pick.revert']) {
      expect(actionDisabledReason(getAction(id)!), id).toBe(expected(kind));
    }
  });

  it("the backend refuses (BUSY) : checkout, cherry-pick / revert, rebase, merge, creation with checkout → toast, no other orders", async () => {
    const fake = await openTestRepo({
      branch_checkout: busy(kind),
      branch_create: busy(kind),
      cherry_pick: busy(kind),
      revert_commit: busy(kind),
      rebase_start: busy(kind),
      merge_branch: busy(kind),
      branch_compare: () => ({
        branchOid: oid('a'), targetOid: oid('b'), mergeBase: oid('c'), ahead: 1, behind: 1, commits: [], merges: 0, pushed: 0, dirty: false,
        defaultMergeMessage: 'Merge',
      }),
    });
    render(DialogHost);
    const lastError = () => toast.items.filter((t) => t.kind === 'error').at(-1)?.message;

    void checkoutTarget({ kind: "local", name: 'topic' });
    await whenIdle();
    await waitFor(() => expect(lastError()).toBe(expected(kind)));

    toast.clear();
    await runPick('cherry-pick', [fxOid(50)]);
    expect(lastError()).toBe(expected(kind));
    toast.clear();
    await runPick('revert', [fxOid(50)]);
    expect(lastError()).toBe(expected(kind));

    toast.clear();
    await startRebase({ branch: null, target: 'main', autostash: false, replayed: 1, kind: 'replay' });
    expect(lastError()).toBe(expected(kind));

    toast.clear();
    void openDialog('merge-dialog', { ref: 'feature' });
    await screen.findByTestId('merge-ff-hint', {}, { timeout: 8000 }); // first dynamic import: transformation of the chunk
    await userEvent.click(screen.getByTestId('merge-submit-btn'));
    await whenIdle();
    await waitFor(() => expect(lastError()).toBe(expected(kind)));
    await userEvent.click(screen.getByTestId('merge-cancel-btn'));

    toast.clear();
    void openDialog('branch-create-dialog', { startPoint: null });
    await userEvent.type(await screen.findByTestId('branch-create-name-input', {}, { timeout: 8000 }), 'topic');
    await userEvent.click(screen.getByTestId('branch-create-submit-btn'));
    await whenIdle();
    await waitFor(() => expect(lastError()).toBe(expected(kind)));

    // The refusals did not launch any other writing.
    const WRITES = ['branch_checkout', 'branch_create', 'branch_delete', 'branch_rename', 'cherry_pick', 'revert_commit', 'rebase_start', 'merge_branch', 'stash_save', 'commit_create'];
    const written = fake.calls.map((c) => c.command).filter((c) => WRITES.includes(c));
    expect(new Set(written)).toEqual(new Set(['branch_checkout', 'cherry_pick', 'revert_commit', 'rebase_start', 'merge_branch', 'branch_create']));
    expect(written).toHaveLength(6); // one attempt per command
  });
});
