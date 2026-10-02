// Merge flow (06 "Merge"): `merge-dialog` and menu entries.
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import OpBanner from '$lib/components/banner/OpBanner.svelte';
import DialogHost from '$lib/components/dialogs-base/DialogHost.svelte';
import '$lib/components/dialogs-base/register';
import { openDialog, preloadDialog } from '$lib/dialogs/registry';
import type { BranchCompare } from '$lib/ipc/types';
import { resolveMenu } from '$lib/menus/registry';
import { runAction } from '$lib/actions/registry';
import { graph } from '$lib/stores/graph.svelte';
import { op } from '$lib/stores/op.svelte';
import { toast } from '$lib/stores/toast.svelte';
import { makeBranch, makeConflictState, makeRefs, makeStatus } from '$lib/test/fixtures';
import { resetAll } from '$lib/test/reset';
import { openTestRepo, oid } from '../test-support';
import '$lib/register-core';
import './register';

const tid = (id: string) => screen.getByTestId(id);
const maybe = (id: string) => screen.queryByTestId(id);

const cmp = (over: Partial<BranchCompare> = {}): BranchCompare => ({
  branchOid: oid('a'), targetOid: oid('b'), mergeBase: oid('c'), ahead: 0, behind: 2, commits: [], merges: 0, pushed: 0, dirty: false,
  defaultMergeMessage: "Merge branch 'feature' into main", ...over,
});

// The dialogues are in lazy loading: they are downloaded once (the first dynamic import of a chunk is slow under vitest).
beforeAll(async () => {
  await Promise.all(['merge-dialog'].map((id) => preloadDialog(id)));
}, 30_000);

beforeEach(() => {
  resetAll({ keepRegistrations: true });
});

async function openMerge(compare: BranchCompare, extra: Record<string, () => unknown> = {}) {
  const fake = await openTestRepo({
    branch_compare: () => compare,
    merge_branch: () => ({ result: 'fast-forward', oid: oid('b') }),
    ...extra,
  });
  render(DialogHost);
  const done = openDialog('merge-dialog', { ref: 'feature' });
  await screen.findByTestId('merge-ff-hint');
  return { fake, done };
}

describe("merge-dialog: pre-analysis by branch_compare", () => {
  it("fast-forward possible: all available modes, no message, send ff", async () => {
    const { fake, done } = await openMerge(cmp());
    expect(fake.callsOf('branch_compare')[0]!.args).toEqual({ repoId: 1, branch: null, target: 'feature' });
    expect(tid('merge-ff-hint')).toHaveTextContent("Fast-forward by 2 commits possible");
    expect(tid('merge-summary')).toHaveTextContent("Merge \"feature\" (2 commits) in \"main\"");
    expect(tid('merge-mode-ff')).toBeChecked();
    expect(tid('merge-mode-ff-only')).toBeEnabled();
    expect(maybe('merge-message-input')).toBeNull();
    expect(tid('merge-submit-btn')).toBeEnabled();

    await userEvent.click(tid('merge-submit-btn'));
    expect(await done).toBe(true);
    expect(fake.callsOf('merge_branch')[0]!.args).toEqual({ repoId: 1, ref: 'feature', mode: 'ff' });
  });

  it("diverged: ff-only disabled, default message visible, no-ff sends message", async () => {
    const { fake, done } = await openMerge(cmp({ ahead: 1, behind: 2 }), { merge_branch: () => ({ result: 'merged', oid: oid('d') }) });
    expect(tid('merge-ff-hint')).toHaveTextContent("Merge commit required");
    expect(tid('merge-mode-ff-only')).toBeDisabled();
    const message = tid('merge-message-input') as HTMLTextAreaElement;
    expect(message.value).toBe("Merge branch 'feature' into main");

    await userEvent.click(tid('merge-mode-no-ff'));
    await userEvent.clear(message);
    await userEvent.type(message, 'Mon merge');
    await userEvent.click(tid('merge-submit-btn'));
    expect(await done).toBe(true);
    expect(fake.callsOf('merge_branch')[0]!.args).toEqual({ repoId: 1, ref: 'feature', mode: 'no-ff', message: 'Mon merge' });
  });

  it("ff-only does not send a message", async () => {
    const { fake, done } = await openMerge(cmp());
    await userEvent.click(tid('merge-mode-ff-only'));
    await userEvent.click(tid('merge-submit-btn'));
    await done;
    expect(fake.callsOf('merge_branch')[0]!.args).toEqual({ repoId: 1, ref: 'feature', mode: 'ff-only' });
  });

  it("already up to date : indication, button disabled", async () => {
    await openMerge(cmp({ behind: 0, ahead: 1 }));
    expect(tid('merge-ff-hint')).toHaveTextContent("Already up to date");
    expect(tid('merge-submit-btn')).toBeDisabled();
  });

  it("changes followed: merge-error, merge-stash-btn, button disabled; stasher recalculate", async () => {
    let dirty = true;
    const { fake } = await openMerge(cmp({ dirty: true }), {
      branch_compare: () => cmp({ dirty }),
      stash_save: () => {
        dirty = false;
        return { created: null, list: [] };
      },
      status_get: () => makeStatus({ files: [{ path: 'a.txt', oldPath: null, staged: null, unstaged: 'modified', conflict: null, oldMode: null, newMode: null, submodule: null, nonUtf8: null }] }),
    });
    expect(tid('merge-error')).toHaveTextContent("Commit or stash your changes before merging.");
    expect(tid('merge-submit-btn')).toBeDisabled();
    await userEvent.click(tid('merge-stash-btn'));
    await waitFor(() => expect(fake.callsOf('stash_save')).toHaveLength(1));
    await waitFor(() => expect(maybe('merge-error')).toBeNull());
    expect(maybe('merge-stash-btn')).toBeNull();
    expect(tid('merge-submit-btn')).toBeEnabled();
    expect(fake.callsOf('merge_branch')).toHaveLength(0);
  });

  it("REJECTED_NON_FF (Course): message in merge-error, open dialog", async () => {
    const { fake } = await openMerge(cmp(), {
      merge_branch: () => {
        throw { code: 'REJECTED_NON_FF', message: 'x', details: { operation: 'merge', stale: false } };
      },
    });
    await userEvent.click(tid('merge-mode-ff-only'));
    await userEvent.click(tid('merge-submit-btn'));
    expect(await screen.findByTestId('merge-error')).toHaveTextContent("Fast forward impossible: branches have diverged.");
    expect(tid('merge-dialog')).toBeInTheDocument();
    expect(toast.items).toHaveLength(0);
    // pre-analysis is reread
    await waitFor(() => expect(fake.callsOf('branch_compare').length).toBeGreaterThanOrEqual(2));
  });

  it("conflict: the dialogue closes and the banner of the base takes over (op:state posed)", async () => {
    const state = makeConflictState({ kind: 'merge', headName: 'refs/heads/main', incoming: 'feature', step: null, total: null, onto: null, ontoLabel: null });
    const { done } = await openMerge(cmp({ ahead: 1 }), {
      merge_branch: () => {
        throw { code: 'CONFLICT', message: 'conflit', details: { state } };
      },
    });
    await userEvent.click(tid('merge-submit-btn'));
    await done;
    expect(op.state?.kind).toBe('merge');
    expect(maybe('merge-dialog')).toBeNull();
  });
});

describe("menu entries merge", () => {
  it("local branch: visible out of current, worded with current; hidden in HEAD detached", async () => {
    await openTestRepo();
    const refs = makeRefs();
    const feature = makeBranch('feature', 5);
    const items = resolveMenu({ menu: 'branch', branch: feature });
    expect(items.map((i) => i.id)).toContain('merge');
    expect(items.find((i) => i.id === 'merge')!.label).toBe("Merge \"feature\" in \"main\"");
    expect(resolveMenu({ menu: 'branch', branch: refs.local[0]! }).map((i) => i.id)).not.toContain('merge'); // current
  });

  it("Remote branch", async () => {
    await openTestRepo();
    const items = resolveMenu({ menu: 'remote-branch', branch: { remote: 'origin', name: 'dev', fullRef: 'refs/remotes/origin/dev', oid: oid('d') } });
    expect(items.find((i) => i.id === 'merge')!.label).toBe("Merge \"origin/dev\" in \"main\"");
  });

  it("shaded during a state-of-the-art operation", async () => {
    await openTestRepo();
    op.setState(makeConflictState());
    const item = resolveMenu({ menu: 'branch', branch: makeBranch('feature', 5) }).find((i) => i.id === 'merge')!;
    expect(item.disabled).toBe(true);
  });
});

describe("drag and drop graph: drag.merge action", () => {
  it("graph.dragDrop bed and opens merge-dialog with ref = src", async () => {
    const fake = await openTestRepo({ branch_compare: () => cmp() });
    render(DialogHost);
    graph.dragDrop = {
      src: { fullRef: 'refs/heads/feature-ff', kind: "local", name: 'feature-ff' },
      dst: { fullRef: 'refs/heads/main', kind: "local", name: 'main' },
    };
    expect(await runAction('drag.merge')).toBe(true);
    await screen.findByTestId('merge-dialog');
    await screen.findByTestId('merge-ff-hint');
    expect(fake.callsOf('branch_compare')[0]!.args).toEqual({ repoId: 1, branch: null, target: 'feature-ff' });
    expect(tid('merge-summary')).toHaveTextContent('Merge "feature-ff"');
  });
});

describe("merges in progress when the repository (terminal, or restart) is opened", () => {
  const mergeState = (over: Partial<ReturnType<typeof makeConflictState>> = {}) =>
    makeConflictState({ kind: 'merge', headName: 'refs/heads/main', incoming: 'feature', onto: null, ontoLabel: null, step: null, total: null, ...over });

  it("RepoInfo.opState restores op-banner[data-kind=merge]: Finish disabled as long as a path is in conflict, Abort, no Skip", async () => {
    await openTestRepo({}, { opState: mergeState() });
    render(OpBanner);
    const banner = await screen.findByTestId('op-banner');
    expect(banner).toHaveAttribute('data-kind', 'merge');
    expect(banner).toHaveAttribute('data-phase', 'conflict');
    expect(tid('op-banner-progress')).toHaveTextContent("Merge feature into main");
    expect(tid('op-banner-continue-btn')).toBeDisabled();
    expect(tid('op-banner-continue-btn')).toHaveTextContent("Finish the merge");
    expect(tid('op-banner-abort-btn')).toBeEnabled();
    expect(maybe('op-banner-skip-btn')).toBeNull();
  });

  it("all paths are staged: Finishing the merge is active", async () => {
    await openTestRepo({}, { opState: mergeState({ conflictedPaths: [] }) });
    render(OpBanner);
    await screen.findByTestId('op-banner');
    expect(tid('op-banner-continue-btn')).toBeEnabled();
  });
});
