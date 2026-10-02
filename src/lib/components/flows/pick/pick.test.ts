// "cherry-pick / revert" stream (09): menu entries, actions, `mainline-dialog`, flow-specific errors.
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { whenIdle } from '$lib/activity';
import { actionDisabledReason, getAction, runAction } from '$lib/actions/registry';
import DialogHost from '$lib/components/dialogs-base/DialogHost.svelte';
import '$lib/components/dialogs-base/register';
import { preloadDialog } from '$lib/dialogs/registry';
import { resolveMenu } from '$lib/menus/registry';
import { graph } from '$lib/stores/graph.svelte';
import { op } from '$lib/stores/op.svelte';
import { toast } from '$lib/stores/toast.svelte';
import { makeConflictState, makeLogPage, makeUndo } from '$lib/test/fixtures';
import { resetAll } from '$lib/test/reset';
import { oid as fixtureOid } from '$lib/test/fixtures';
import { openTestRepo } from '../test-support';
import '$lib/register-core';
import './register';
import { registerPickErrorHandlers } from './errors';

const tid = (id: string) => screen.getByTestId(id);
const maybe = (id: string) => screen.queryByTestId(id);
const HEAD_OK = { head: { branch: 'main', oid: fixtureOid(61), detached: false, unborn: false } };

// The dialogues are in lazy loading: they are downloaded once (the first dynamic import of a chunk is slow under vitest).
beforeAll(async () => {
  await preloadDialog('mainline-dialog');
}, 30_000);

beforeEach(() => {
  resetAll({ keepRegistrations: true });
  registerPickErrorHandlers();
});

/** Linear log page 60..1 of which commit 55 is a merge (parents 54 and 30) and commit 40 is a merge with three parents. */
function pageWithMerges() {
  const page = makeLogPage();
  page.rows.find((r) => r.oid === fixtureOid(55))!.parents = [fixtureOid(54), fixtureOid(30)];
  page.rows.find((r) => r.oid === fixtureOid(40))!.parents = [fixtureOid(39), fixtureOid(20), fixtureOid(10)];
  page.rows.find((r) => r.oid === fixtureOid(30))!.refs = [{ name: 'side', fullRef: 'refs/heads/side', kind: "local", isHead: false }];
  return page;
}

function undoOf(kind: 'cherry-pick' | 'revert') {
  const u = makeUndo(true);
  return { ...u, entry: { ...u.entry!, kind } };
}

describe("graph menu entries", () => {
  it("cherry-pick and revert: singular and plural wording, cherry-pick masked if selection contains HEAD", async () => {
    await openTestRepo();
    const one = resolveMenu({ menu: 'commit', oid: fixtureOid(50), oids: [fixtureOid(50)] });
    expect(one.find((i) => i.id === 'cherry-pick')!.label).toBe("Cherry-pick this commit");
    expect(one.find((i) => i.id === 'revert')!.label).toBe("Revert this commit");
    const many = resolveMenu({ menu: 'commit', oid: fixtureOid(50), oids: [fixtureOid(50), fixtureOid(49), fixtureOid(48)] });
    expect(many.find((i) => i.id === 'cherry-pick')!.label).toBe('Cherry-pick 3 commits');
    expect(many.find((i) => i.id === 'revert')!.label).toBe('Revert 3 commits');
    // HEAD = oid(60)
    const withHead = resolveMenu({ menu: 'commit', oid: fixtureOid(60), oids: [fixtureOid(60)] });
    expect(withHead.map((i) => i.id)).not.toContain('cherry-pick');
    expect(withHead.map((i) => i.id)).toContain('revert');
  });

  it("shaded during a state-of-the-art operation", async () => {
    await openTestRepo();
    op.setState(makeConflictState());
    const items = resolveMenu({ menu: 'commit', oid: fixtureOid(50), oids: [fixtureOid(50)] });
    expect(items.find((i) => i.id === 'cherry-pick')!.disabled).toBe(true);
  });
});

describe("cherry-pick / revert free of merge: leaves immediately, without confirmation", () => {
  it("cherry-pick of several commits: one single command, oids as (backend imposes order), toastdundo", async () => {
    const fake = await openTestRepo({ cherry_pick: () => HEAD_OK, undo_peek: () => undoOf('cherry-pick') });
    const items = resolveMenu({ menu: 'commit', oid: fixtureOid(50), oids: [fixtureOid(50), fixtureOid(49)] });
    await items.find((i) => i.id === 'cherry-pick')!.run();
    await whenIdle();
    expect(fake.callsOf('cherry_pick')).toHaveLength(1);
    expect(fake.callsOf('cherry_pick')[0]!.args).toEqual({ repoId: 1, oids: [fixtureOid(50), fixtureOid(49)] });
    expect(maybe('mainline-dialog')).toBeNull();
    await waitFor(() => expect(toast.items.some((t) => t.kind === 'undo')).toBe(true));
    expect(toast.items.find((t) => t.kind === 'undo')!.message).toBe("2 commits Cherry-picked on main");
  });

  it("revert d’un commit : revert_commit, toast « 1 commit reverted on main »", async () => {
    const fake = await openTestRepo({ revert_commit: () => HEAD_OK, undo_peek: () => undoOf('revert') });
    const items = resolveMenu({ menu: 'commit', oid: fixtureOid(58), oids: [fixtureOid(58)] });
    await items.find((i) => i.id === 'revert')!.run();
    await whenIdle();
    expect(fake.callsOf('revert_commit')[0]!.args).toEqual({ repoId: 1, oids: [fixtureOid(58)] });
    await waitFor(() => expect(toast.items.find((t) => t.kind === 'undo')?.message).toBe("1 commit reverted on main"));
  });

  it("conflict: no toast error, state of operation", async () => {
    await openTestRepo({
      cherry_pick: () => {
        throw { code: 'CONFLICT', message: 'conflit', details: { state: makeConflictState({ kind: 'cherry-pick' }) } };
      },
    });
    await runAction('pick.cherry-pick', { menu: 'commit', oid: fixtureOid(50), oids: [fixtureOid(50)] });
    await whenIdle();
    expect(op.state?.kind).toBe('cherry-pick');
    expect(toast.items).toHaveLength(0);
  });

  it("already-in-head: explicit message, no silent filtering", async () => {
    await openTestRepo({
      cherry_pick: () => {
        throw { code: 'INVALID_ARGUMENT', message: 'x', details: { field: 'oids', reason: 'already-in-head', oids: [fixtureOid(50), fixtureOid(49)] } };
      },
    });
    await runAction('pick.cherry-pick', { menu: 'commit', oid: fixtureOid(50), oids: [fixtureOid(50), fixtureOid(49)] });
    await whenIdle();
    expect(toast.items.at(-1)?.message).toBe("2 commits are already in main: nothing to cherry-pick.");
  });

  it('not-in-head (revert)', async () => {
    await openTestRepo({
      revert_commit: () => {
        throw { code: 'INVALID_ARGUMENT', message: 'x', details: { field: 'oids', reason: 'not-in-head', oids: [fixtureOid(50)] } };
      },
    });
    await runAction('pick.revert', { menu: 'commit', oid: fixtureOid(50), oids: [fixtureOid(50)] });
    await whenIdle();
    expect(toast.items.at(-1)?.message).toBe("Only commits in the current branch can be reverted.");
  });
});

describe('actions pick.cherry-pick / pick.revert (contrat inter-agents)', () => {
  it("without target: operate on graph selection", async () => {
    const fake = await openTestRepo({ cherry_pick: () => HEAD_OK });
    graph.selectCommits([fixtureOid(50), fixtureOid(49)]);
    await runAction('pick.cherry-pick');
    await whenIdle();
    expect(fake.callsOf('cherry_pick')[0]!.args).toEqual({ repoId: 1, oids: [fixtureOid(50), fixtureOid(49)] });
  });

  it("deactivated: without selection, selection containing HEAD (cherry-pick), during operation", async () => {
    await openTestRepo();
    const cp = getAction('pick.cherry-pick')!;
    const rv = getAction('pick.revert')!;
    expect(actionDisabledReason(cp)).toBe("Select at least one commit");
    graph.selectCommits([fixtureOid(60), fixtureOid(59)]);
    expect(actionDisabledReason(cp)).toBe("The selection contains HEAD");
    expect(actionDisabledReason(rv)).toBeNull();
    graph.selectCommits([fixtureOid(50)]);
    expect(actionDisabledReason(cp)).toBeNull();
    op.setState(makeConflictState());
    expect(actionDisabledReason(cp)).toContain("Finish or abort");
  });

  it("a selection WIP or stash is not a selection of commits", async () => {
    const fake = await openTestRepo({ cherry_pick: () => HEAD_OK });
    graph.selectStash(fixtureOid(900), 0);
    expect(actionDisabledReason(getAction('pick.cherry-pick')!)).toBe("Select at least one commit");
    await runAction('pick.cherry-pick');
    expect(fake.callsOf('cherry_pick')).toHaveLength(0);
  });
});

describe('mainline-dialog', () => {
  async function withMerges(extra: Record<string, () => unknown> = {}) {
    const fake = await openTestRepo({ log_page: () => pageWithMerges(), cherry_pick: () => HEAD_OK, revert_commit: () => HEAD_OK, ...extra });
    render(DialogHost);
    return fake;
  }
  const merge55 = { menu: 'commit' as const, oid: fixtureOid(55), oids: [fixtureOid(55)] };

  it("cherry-pick of a merge: parent 1 preselected, -x unchecked by default; confirm send mainline and recordOrigin", async () => {
    const fake = await withMerges();
    const running = runAction('pick.cherry-pick', merge55);
    const dlg = await screen.findByTestId('mainline-dialog');
    expect(dlg).toHaveAttribute('data-action', 'cherry-pick');
    expect(within(tid('mainline-merge-list')).getAllByTestId('mainline-merge-item')).toHaveLength(1);
    const select = tid('mainline-select') as HTMLSelectElement;
    expect(select.value).toBe('1');
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'Parent 1 — 0000000 "feat: dark theme"',
      'Parent 2 — 0000000 "feat: login form" (side)',
    ]);
    expect(tid('mainline-record-origin-checkbox')).not.toBeChecked();
    expect(maybe('mainline-revert-warning')).toBeNull();
    expect(maybe('mainline-forced-hint')).toBeNull();
    await userEvent.selectOptions(select, '2');
    await userEvent.click(tid('mainline-record-origin-checkbox'));
    await userEvent.click(tid('mainline-confirm-btn'));
    await running;
    expect(fake.callsOf('cherry_pick')[0]!.args).toEqual({ repoId: 1, oids: [fixtureOid(55)], mainline: 2, recordOrigin: true });
  });

  it("revert of a merge: warning, no checkbox -x; canceling does not call anything", async () => {
    const fake = await withMerges();
    const running = runAction('pick.revert', merge55);
    const dlg = await screen.findByTestId('mainline-dialog');
    expect(dlg).toHaveAttribute('data-action', 'revert');
    expect(tid('mainline-revert-warning')).toHaveTextContent("Reverting a merge keeps its history");
    expect(maybe('mainline-record-origin-checkbox')).toBeNull();
    await userEvent.click(tid('mainline-cancel-btn'));
    await running;
    expect(fake.callsOf('revert_commit')).toHaveLength(0);
    expect(maybe('mainline-dialog')).toBeNull();

    const again = runAction('pick.revert', merge55);
    await screen.findByTestId('mainline-dialog');
    await userEvent.click(tid('mainline-confirm-btn'));
    await again;
    expect(fake.callsOf('revert_commit')[0]!.args).toEqual({ repoId: 1, oids: [fixtureOid(55)], mainline: 1 });
  });

  it("several merges : 1...min(p) ; mixture with a single commit : parent 1 imposed with mention", async () => {
    await withMerges();
    const two = runAction('pick.revert', { menu: 'commit', oid: fixtureOid(55), oids: [fixtureOid(55), fixtureOid(40)] });
    await screen.findByTestId('mainline-dialog');
    expect([...(tid('mainline-select') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['1', '2']);
    expect(within(tid('mainline-merge-list')).getAllByTestId('mainline-merge-item')).toHaveLength(2);
    await userEvent.click(tid('mainline-cancel-btn'));
    await two;

    const mixed = runAction('pick.revert', { menu: 'commit', oid: fixtureOid(55), oids: [fixtureOid(55), fixtureOid(50)] });
    await screen.findByTestId('mainline-dialog');
    expect([...(tid('mainline-select') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['1']);
    expect(tid('mainline-forced-hint')).toHaveTextContent("Parent 1 is required when the selection contains both merges and regular commits.");
    await userEvent.click(tid('mainline-cancel-btn'));
    await mixed;
  });

  it("A three-parented merge offers 1, 2 and 3", async () => {
    await withMerges();
    const running = runAction('pick.cherry-pick', { menu: 'commit', oid: fixtureOid(40), oids: [fixtureOid(40)] });
    await screen.findByTestId('mainline-dialog');
    expect([...(tid('mainline-select') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['1', '2', '3']);
    await userEvent.click(tid('mainline-cancel-btn'));
    await running;
  });
});
