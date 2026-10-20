// "rebase" stream (07): `rebase-confirm-dialog`, `rebase-todo-panel`, menu entries, banner actions.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { whenIdle } from '$lib/activity';
import { abortConfirmMessage, skipNeedsConfirm } from './banner-actions';
import { actionDisabledReason, getAction, runAction } from '$lib/actions/registry';
import DialogHost from '$lib/components/dialogs-base/DialogHost.svelte';
import '$lib/components/dialogs-base/register';
import { openDialog, preloadDialog } from '$lib/dialogs/registry';
import type { BranchCompare, FileStatus, TodoPreview, TodoPreviewItem } from '$lib/ipc/types';
import { resolveMenu } from '$lib/menus/registry';
import { graph } from '$lib/stores/graph.svelte';
import { op } from '$lib/stores/op.svelte';
import { repo } from '$lib/stores/repo.svelte';
import { status } from '$lib/stores/status.svelte';
import { toast } from '$lib/stores/toast.svelte';
import { ui } from '$lib/stores/ui.svelte';
import { makeBranch, makeConflictState, makeRefs, makeStashes, makeStatus, makeUndo, oid as fxOid } from '$lib/test/fixtures';
import { resetAll } from '$lib/test/reset';
import { openTestRepo, oid } from '../test-support';
import '$lib/register-core';
import './register';
import RebaseTodoPanel from './RebaseTodoPanel.svelte';

const tid = (id: string) => screen.getByTestId(id);
const maybe = (id: string) => screen.queryByTestId(id);

// The dialogues are in lazy loading: they are downloaded once (the first dynamic import of a chunk is slow under vitest).
beforeAll(async () => {
  await Promise.all(['rebase-confirm-dialog', 'squash-dialog', 'reword-dialog'].map((id) => preloadDialog(id)));
}, 30_000);

beforeEach(() => {
  resetAll({ keepRegistrations: true });
});

/** refs Snapshot of which HEAD is `feature` (the default fixture branch, `main`, would trigger the "default branch" box). */
function refsOnFeature() {
  const r = makeRefs();
  return {
    ...r,
    head: { kind: 'branch' as const, name: 'feature' },
    local: [...r.local.map((b) => ({ ...b, isHead: false })), makeBranch('feature', 61, { isHead: true })],
  };
}

const cmp = (over: Partial<BranchCompare> = {}): BranchCompare => ({
  branchOid: oid('a'), targetOid: oid('b'), mergeBase: oid('c'), ahead: 2, behind: 1, merges: 0, pushed: 0, dirty: false, defaultMergeMessage: '',
  commits: [
    { oid: oid('1'), summary: "A: adds a.txt", pushed: false },
    { oid: oid('2'), summary: 'B: typo', pushed: false },
  ],
  ...over,
});

describe("drag and drop graph: drag.rebase action", () => {
  it("graph.dragDrop bed and opens rebase-confirm-dialog (branche = src, target = dst)", async () => {
    const fake = await openTestRepo({ refs_list: () => refsOnFeature(), branch_compare: () => cmp() });
    render(DialogHost);
    graph.dragDrop = {
      src: { fullRef: 'refs/heads/feature', kind: "local", name: 'feature' },
      dst: { fullRef: 'refs/heads/main', kind: "local", name: 'main' },
    };
    expect(await runAction('drag.rebase')).toBe(true);
    await screen.findByTestId('rebase-confirm-dialog');
    await screen.findByTestId('rebase-confirm-summary');
    expect(fake.callsOf('branch_compare')[0]!.args).toEqual({ repoId: 1, branch: 'feature', target: 'main' });
    await userEvent.click(tid('rebase-cancel-btn'));
  });

  it("disabled during an ongoing operation", async () => {
    await openTestRepo();
    op.setState(makeConflictState());
    expect(await runAction('drag.rebase')).toBe(false);
  });
});

describe('rebase-confirm-dialog', () => {
  async function open(compare: BranchCompare, props: Record<string, unknown> = { branch: null, target: 'main' }, extra: Record<string, () => unknown> = {}) {
    const fake = await openTestRepo({ refs_list: () => refsOnFeature(), branch_compare: () => compare, rebase_start: () => ({ head: { branch: 'feature', oid: oid('f'), detached: false, unborn: false } }), ...extra });
    render(DialogHost);
    const done = openDialog('rebase-confirm-dialog', props);
    await screen.findByTestId('rebase-confirm-summary');
    return { fake, done };
  }

  it("Replayed commits: list (sha7, subject), summary with target, confirmation → rebase_start [L] with opId", async () => {
    const { fake, done } = await open(cmp(), { branch: 'topic', target: 'main' });
    expect(fake.callsOf('branch_compare')[0]!.args).toEqual({ repoId: 1, branch: 'topic', target: 'main' });
    expect(tid('rebase-confirm-summary')).toHaveTextContent("2 commits of \"topic\" will be replayed on \"main\" (bbbbbbb)");
    const items = screen.getAllByTestId('rebase-commit-item');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAttribute('data-oid', oid('1'));
    expect(items[0]).toHaveTextContent('1111111');
    expect(items[0]).toHaveTextContent("A: adds a.txt");
    expect(tid('rebase-checkout-notice')).toHaveTextContent("HEAD will switch to \"topic\".");
    expect(maybe('rebase-pushed-warning')).toBeNull();
    expect(maybe('rebase-merges-notice')).toBeNull();
    expect(maybe('rebase-autostash-checkbox')).toBeNull();

    await userEvent.click(tid('rebase-confirm-btn'));
    expect(await done).toBe(true);
    await waitFor(() => expect(fake.callsOf('rebase_start')).toHaveLength(1));
    const args = fake.callsOf('rebase_start')[0]!.args;
    expect(args).toMatchObject({ repoId: 1, onto: 'main', branch: 'topic', autostash: false });
    expect(typeof args.opId).toBe('string');
    expect((args.opId as string).length).toBeGreaterThan(20);
  });

  it("current branch: no checkout; linearized merges and commits pushed reported", async () => {
    await open(cmp({ merges: 2, pushed: 1, commits: [{ oid: oid('1'), summary: 'A', pushed: true }] }), { branch: null, target: 'origin/dev' });
    expect(maybe('rebase-checkout-notice')).toBeNull();
    expect(tid('rebase-merges-notice')).toHaveTextContent("2 merge commits will be linearized.");
    expect(tid('rebase-pushed-warning')).toHaveTextContent("1 commit in this range is already on");
    expect(screen.getAllByTestId('rebase-commit-item')[0]).toHaveAttribute('data-pushed', 'true');
    expect(tid('rebase-confirm-btn')).toBeEnabled();
  });

  it("nothing to do (behind = 0): message, no confirmation button", async () => {
    await open(cmp({ behind: 0 }), { branch: 'feature', target: 'main' });
    expect(tid('rebase-confirm-summary')).toHaveTextContent("\"feature\" already contains \"main\": nothing to rebase.");
    expect(maybe('rebase-confirm-btn')).toBeNull();
    expect(maybe('rebase-commit-list')).toBeNull();
  });

  it("simple fast forward (ahead = 0, behind > 0): same button", async () => {
    await open(cmp({ ahead: 0, behind: 3, commits: [] }), { branch: 'feature', target: 'main' });
    expect(tid('rebase-confirm-summary')).toHaveTextContent("\"feature\" will be advanced to \"main\" (no replayed commit).");
    expect(tid('rebase-confirm-btn')).toBeEnabled();
  });

  it("beyond 200 commits: \"and N other\"", async () => {
    await open(cmp({ ahead: 205 }), { branch: 'feature', target: 'main' });
    expect(screen.getByText("and 203 other")).toBeInTheDocument();
  });

  it("default branch: checkbox to confirm", async () => {
    const { fake } = await open(cmp(), { branch: 'main', target: 'origin/main' });
    expect(tid('rebase-confirm-btn')).toBeDisabled();
    await userEvent.click(tid('rebase-confirm-default-branch-checkbox'));
    expect(tid('rebase-confirm-btn')).toBeEnabled();
    await userEvent.click(tid('rebase-confirm-btn'));
    await waitFor(() => expect(fake.callsOf('rebase_start')).toHaveLength(1));
  });

  it("worktree dirty: autostash checked by default, sent to rebase_start", async () => {
    const { fake } = await open(cmp({ dirty: true }));
    expect(tid('rebase-autostash-checkbox')).toBeChecked();
    await userEvent.click(tid('rebase-confirm-btn'));
    await waitFor(() => expect(fake.callsOf('rebase_start')).toHaveLength(1));
    expect(fake.callsOf('rebase_start')[0]!.args).toMatchObject({ autostash: true });
  });

  it("DIRTY_WORKTREE: the dialogue opens again on rebase-retry-autostash-btn, which restarts with autostash", async () => {
    let n = 0;
    const { fake } = await open(cmp(), { branch: null, target: 'main' }, {
      rebase_start: () => {
        if (n++ === 0) throw { code: 'DIRTY_WORKTREE', message: 'sale', details: { paths: ['README.md'] } };
        return { head: { branch: 'feature', oid: oid('f'), detached: false, unborn: false } };
      },
    });
    await userEvent.click(tid('rebase-confirm-btn'));
    const retry = await screen.findByTestId('rebase-retry-autostash-btn');
    expect(tid('rebase-confirm-dirty')).toHaveTextContent("1 modified file prevents rebase");
    expect(maybe('rebase-confirm-btn')).toBeNull();
    await userEvent.click(retry);
    await waitFor(() => expect(fake.callsOf('rebase_start')).toHaveLength(2));
    expect(fake.callsOf('rebase_start')[1]!.args).toMatchObject({ onto: 'main', branch: null, autostash: true });
  });

  it("CANCELLED: toast d'information \"the repository has returned to its state before\"", async () => {
    await open(cmp(), { branch: null, target: 'main' }, {
      rebase_start: () => {
        throw { code: 'CANCELLED', message: "cancelled", details: { opId: 'x' } };
      },
    });
    await userEvent.click(tid('rebase-confirm-btn'));
    await whenIdle();
    await waitFor(() => expect(toast.items.at(-1)?.message).toBe("Rebase interrupted: the repository returned to its previous state."));
    expect(toast.items.at(-1)?.kind).toBe('info');
  });

  it("CONFLICT: no toast, operation state is set (base bar)", async () => {
    await open(cmp(), { branch: null, target: 'main' }, {
      rebase_start: () => {
        throw { code: 'CONFLICT', message: 'conflit', details: { state: makeConflictState() } };
      },
    });
    await userEvent.click(tid('rebase-confirm-btn'));
    await waitFor(() => expect(op.state?.kind).toBe('rebase'));
    expect(toast.items).toHaveLength(0);
  });
});

// ── Rebase interactif

const item = (n: number, summary: string, extra: Partial<TodoPreviewItem> = {}): TodoPreviewItem => ({
  oid: oid(String(n)), shortOid: String(n).repeat(7), summary, message: summary, author: 'Bot', pushed: false, ...extra,
});
const A = item(1, "A: adds a.txt");
const B = item(2, 'B: typo');
const C = item(3, "C: adds c.txt");
const FX = item(4, "fixup! A: add a.txt");
const D = item(5, "D: adds d.txt");
const preview = (items = [A, B, C, FX, D]): TodoPreview => ({ base: oid('9'), head: oid('f'), items });

async function openPanel(extra: Record<string, () => unknown> = {}, items?: TodoPreviewItem[]) {
  const fake = await openTestRepo({
    rebase_todo_preview: () => preview(items),
    rebase_interactive_start: () => ({ head: { branch: 'main', oid: oid('e'), detached: false, unborn: false } }),
    ...extra,
  });
  render(RebaseTodoPanel, { upstream: 'main' });
  await screen.findAllByTestId('rebase-todo-row');
  return fake;
}

const rowsOf = () => screen.getAllByTestId('rebase-todo-row');
const row = (o: string) => rowsOf().find((r) => r.getAttribute('data-oid') === o)!;
const selectOf = (o: string) => within(row(o)).getByTestId('rebase-todo-action-select') as HTMLSelectElement;

describe('rebase-todo-panel', () => {
  it("load preview: one line by commit, git order, default pick, summary", async () => {
    const fake = await openPanel();
    expect(fake.callsOf('rebase_todo_preview')[0]!.args).toEqual({ repoId: 1, upstream: 'main' });
    expect(rowsOf().map((r) => r.getAttribute('data-oid'))).toEqual([A, B, C, FX, D].map((i) => i.oid));
    expect(rowsOf().every((r) => r.getAttribute('data-action') === 'pick')).toBe(true);
    expect(tid('rebase-todo-summary')).toHaveTextContent('5 commits → 5 commits');
    expect(tid('rebase-todo-start-btn')).toBeEnabled();
    expect(maybe('rebase-todo-error')).toBeNull();
    expect(maybe('rebase-todo-message-input')).toBeNull();
  });

  it("IRB-04 : first line in squash → button disabled and exact message", async () => {
    await openPanel();
    await userEvent.selectOptions(selectOf(A.oid), 'squash');
    expect(tid('rebase-todo-start-btn')).toBeDisabled();
    expect(tid('rebase-todo-error')).toHaveTextContent("The first commit cannot be merged with a previous commit.");
  });

  it("all drop: error all-dropped", async () => {
    await openPanel(undefined, [A, B]);
    await userEvent.selectOptions(selectOf(A.oid), 'drop');
    await userEvent.selectOptions(selectOf(B.oid), 'drop');
    expect(tid('rebase-todo-error')).toHaveTextContent("At least one commit must be kept.");
    expect(tid('rebase-todo-start-btn')).toBeDisabled();
    expect(row(A.oid)).toHaveAttribute('data-action', 'drop');
  });

  it("reword: pre-filled field, empty message refused", async () => {
    await openPanel();
    await userEvent.selectOptions(selectOf(C.oid), 'reword');
    const input = within(row(C.oid)).getByTestId('rebase-todo-message-input') as HTMLTextAreaElement;
    expect(input.value).toBe("C: adds c.txt");
    await fireEvent.input(input, { target: { value: '   ' } });
    expect(tid('rebase-todo-error')).toHaveTextContent("The message of a reformulated commit cannot be empty.");
    expect(tid('rebase-todo-start-btn')).toBeDisabled();
  });

  it("IRB-01: fixup, squash with final message, keyboard reordering, reword → TodoItem[] exact", async () => {
    const fake = await openPanel();
    // 1. fixup! A → fixup, moved under A (Alt+↑ ×2 from 4th place)
    await userEvent.selectOptions(selectOf(FX.oid), 'fixup');
    const handleFx = within(row(FX.oid)).getByTestId('rebase-todo-drag-handle');
    handleFx.focus();
    await userEvent.keyboard('{Alt>}{ArrowUp}{ArrowUp}{/Alt}');
    // 2. B → squash: Last member of the group, he carries the final message
    await userEvent.selectOptions(selectOf(B.oid), 'squash');
    const groupInput = within(row(B.oid)).getByTestId('rebase-todo-message-input') as HTMLTextAreaElement;
    expect(groupInput.value).toBe("A: adds a.txt\n\nB: typo");
    await fireEvent.input(groupInput, { target: { value: "A: adds a.txt\n\nInclut la correction B." } });
    // 3. D above de C
    within(row(D.oid)).getByTestId('rebase-todo-drag-handle').focus();
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    // 4. C → reword
    await userEvent.selectOptions(selectOf(C.oid), 'reword');
    const rw = within(row(C.oid)).getByTestId('rebase-todo-message-input') as HTMLTextAreaElement;
    await fireEvent.input(rw, { target: { value: "C: adds c.txt (renamed)" } });

    expect(rowsOf().map((r) => r.getAttribute('data-oid'))).toEqual([A, FX, B, D, C].map((i) => i.oid));
    expect(tid('rebase-todo-summary')).toHaveTextContent('5 commits → 3 commits');
    expect(tid('rebase-todo-start-btn')).toBeEnabled();

    await userEvent.click(tid('rebase-todo-start-btn'));
    await waitFor(() => expect(fake.callsOf('rebase_interactive_start')).toHaveLength(1));
    const args = fake.callsOf('rebase_interactive_start')[0]!.args;
    expect(args).toMatchObject({ repoId: 1, upstream: 'main', expectedHead: oid('f'), autostash: false });
    expect(args.todo).toEqual([
      { oid: A.oid, action: 'pick' },
      { oid: FX.oid, action: 'fixup' },
      { oid: B.oid, action: 'squash', message: "A: adds a.txt\n\nInclut la correction B." },
      { oid: D.oid, action: 'pick' },
      { oid: C.oid, action: 'reword', message: "C: adds c.txt (renamed)" },
    ]);
    await whenIdle();
    expect(ui.centerIsGraph).toBe(true);
  });

  describe("reordering at Pointer Events (never HTML5 DnD)", () => {
    // No layout under jsdom: line i occupies [30 i, 30 i + 30[ (mid = 30 i + 15).
    function layoutRows() {
      const original = HTMLElement.prototype.getBoundingClientRect;
      HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
        if (this.dataset.testid === 'rebase-todo-row') {
          const i = rowsOf().indexOf(this);
          return { top: 30 * i, bottom: 30 * i + 30, left: 0, right: 400, width: 400, height: 30, x: 0, y: 30 * i, toJSON: () => ({}) } as DOMRect;
        }
        return original.call(this);
      };
      return () => {
        HTMLElement.prototype.getBoundingClientRect = original;
      };
    }
    const pointer = (type: string, y: number) => new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY: y });
    const order = () => rowsOf().map((r) => r.getAttribute('data-oid'));

    it("slide the handle of \"fixup! A\" just under A (half low line A)", async () => {
      const restore = layoutRows();
      try {
        await openPanel();
        const handle = within(row(FX.oid)).getByTestId('rebase-todo-drag-handle');
        handle.dispatchEvent(pointer('pointerdown', 3 * 30 + 15));
        window.dispatchEvent(pointer('pointermove', 20)); // below the middle of A (15): location 1
        await waitFor(() => expect(row(A.oid)).not.toHaveClass('drop-before'));
        expect(row(B.oid)).toHaveClass('drop-before'); // indicator marks the location before B
        window.dispatchEvent(pointer('pointerup', 20));
        await waitFor(() => expect(order()).toEqual([A, FX, B, C, D].map((i) => i.oid)));
      } finally {
        restore();
      }
    });

    it("Drag D above from C; drop on your own place doesn't change anything", async () => {
      const restore = layoutRows();
      try {
        await openPanel();
        within(row(D.oid)).getByTestId('rebase-todo-drag-handle').dispatchEvent(pointer('pointerdown', 4 * 30 + 15));
        window.dispatchEvent(pointer('pointermove', 2 * 30 + 5)); // half high of C
        window.dispatchEvent(pointer('pointerup', 2 * 30 + 5));
        await waitFor(() => expect(order()).toEqual([A, B, D, C, FX].map((i) => i.oid)));

        within(row(A.oid)).getByTestId('rebase-todo-drag-handle').dispatchEvent(pointer('pointerdown', 15));
        window.dispatchEvent(pointer('pointermove', 20)); // juste en dessous de sa propre place
        window.dispatchEvent(pointer('pointerup', 20));
        expect(order()).toEqual([A, B, D, C, FX].map((i) => i.oid));
      } finally {
        restore();
      }
    });

    it("Escape during slipping", async () => {
      const restore = layoutRows();
      try {
        await openPanel();
        within(row(FX.oid)).getByTestId('rebase-todo-drag-handle').dispatchEvent(pointer('pointerdown', 3 * 30 + 15));
        window.dispatchEvent(pointer('pointermove', 5));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        window.dispatchEvent(pointer('pointerup', 5));
        expect(order()).toEqual([A, B, C, FX, D].map((i) => i.oid));
        expect(rowsOf().some((r) => r.classList.contains('dragging'))).toBe(false);
      } finally {
        restore();
      }
    });
  });

  it("a group message left as pre-filled is not sent", async () => {
    const fake = await openPanel(undefined, [A, B]);
    await userEvent.selectOptions(selectOf(B.oid), 'squash');
    await userEvent.click(tid('rebase-todo-start-btn'));
    await waitFor(() => expect(fake.callsOf('rebase_interactive_start')).toHaveLength(1));
    expect(fake.callsOf('rebase_interactive_start')[0]!.args.todo).toEqual([{ oid: A.oid, action: 'pick' }, { oid: B.oid, action: 'squash' }]);
  });

  it("drop: the line is marked, the summary counts deletions", async () => {
    const fake = await openPanel();
    await userEvent.selectOptions(selectOf(D.oid), 'drop');
    expect(tid('rebase-todo-summary')).toHaveTextContent("5 commits → 4 commits, 1 deleted");
    await userEvent.click(tid('rebase-todo-start-btn'));
    await waitFor(() => expect(fake.callsOf('rebase_interactive_start')).toHaveLength(1));
    expect((fake.callsOf('rebase_interactive_start')[0]!.args.todo as { oid: string; action: string }[]).find((i) => i.oid === D.oid)!.action).toBe('drop');
  });

  it("commits pushed: icon on line, non-blocking warning", async () => {
    await openPanel(undefined, [A, item(2, 'B', { pushed: true })]);
    expect(tid('rebase-todo-pushed-warning')).toHaveTextContent("1 commit in this range is already on a remote");
    expect(row(oid('2'))).toHaveAttribute('data-pushed', 'true');
    expect(row(A.oid)).toHaveAttribute('data-pushed', 'false');
    expect(tid('rebase-todo-start-btn')).toBeEnabled();
  });

  it("IRB-03: Cancel close the panel without calling rebase_interactive_start", async () => {
    const fake = await openPanel();
    ui.openCenter('rebase-todo-panel', { upstream: 'main' });
    await userEvent.click(tid('rebase-todo-cancel-btn'));
    expect(ui.centerIsGraph).toBe(true);
    expect(fake.callsOf('rebase_interactive_start')).toHaveLength(0);
  });

  it("autostash: box visible only if the worktree is dirty", async () => {
    const dirtyFile = { path: 'a.txt', oldPath: null, staged: null, unstaged: 'modified' as const, conflict: null, oldMode: null, newMode: null, submodule: null, nonUtf8: null };
    const fake = await openPanel({ status_get: () => makeStatus({ files: [dirtyFile] }) });
    expect(tid('rebase-todo-autostash-checkbox')).toBeChecked();
    await userEvent.click(tid('rebase-todo-start-btn'));
    await waitFor(() => expect(fake.callsOf('rebase_interactive_start')).toHaveLength(1));
    expect(fake.callsOf('rebase_interactive_start')[0]!.args).toMatchObject({ autostash: true });
  });

  it("STALE { todo }: silent charging, no toast", async () => {
    let n = 0;
    const fake = await openPanel({
      rebase_interactive_start: () => {
        if (n++ === 0) throw { code: 'STALE', message: "expired", details: { what: 'todo' } };
        return { head: { branch: 'main', oid: oid('e'), detached: false, unborn: false } };
      },
    });
    await userEvent.click(tid('rebase-todo-start-btn'));
    await waitFor(() => expect(fake.callsOf('rebase_todo_preview')).toHaveLength(2));
    expect(toast.items).toHaveLength(0);
    expect(tid('rebase-todo-panel')).toBeInTheDocument();
  });

  it('UNSUPPORTED_MERGES / DETACHED_HEAD au chargement : rebase-todo-error', async () => {
    await openTestRepo({
      rebase_todo_preview: () => {
        throw { code: 'UNSUPPORTED_MERGES', message: 'merges', details: { oids: [oid('1')] } };
      },
    });
    render(RebaseTodoPanel, { upstream: 'main' });
    expect(await screen.findByTestId('rebase-todo-error')).toHaveTextContent("Range containing merges: not supported in v1.");
    expect(tid('rebase-todo-start-btn')).toBeDisabled();
    expect(toast.items).toHaveLength(0);
  });

  it("CONFLICT at launch: panel closes, banner takes over", async () => {
    await openPanel({
      rebase_interactive_start: () => {
        throw { code: 'CONFLICT', message: 'conflit', details: { state: makeConflictState() } };
      },
    });
    ui.openCenter('rebase-todo-panel', { upstream: 'main' });
    await userEvent.click(tid('rebase-todo-start-btn'));
    await waitFor(() => expect(op.state?.kind).toBe('rebase'));
    expect(ui.centerIsGraph).toBe(true);
  });
});

describe("menu entries rebase", () => {
  it("branch: rebase-onto and interactive-rebase-onto, masked on current", async () => {
    await openTestRepo();
    const ids = (b: ReturnType<typeof makeBranch>) => resolveMenu({ menu: 'branch', branch: b }).map((i) => i.id);
    expect(ids(makeBranch('feature', 5))).toEqual(expect.arrayContaining(['rebase-onto', 'interactive-rebase-onto']));
    const current = makeBranch('main', 60, { isHead: true });
    expect(ids(current)).not.toContain('rebase-onto');
    expect(ids(current)).not.toContain('interactive-rebase-onto');
    const labels = resolveMenu({ menu: 'branch', branch: makeBranch('dev', 5) });
    expect(labels.find((i) => i.id === 'rebase-onto')!.label).toBe("Rebase main on dev");
    expect(labels.find((i) => i.id === 'interactive-rebase-onto')!.label).toBe('Interactive rebase of "main" on "dev"...');
  });

  it("commit: rebase-onto (one commit out of HEAD); interactive-rebase masked if the commit is certainly not an ancestor", async () => {
    await openTestRepo();
    // Test log_page: linear lines 60.1; HEAD = 60 (oid(60)).
    const head = '0'.repeat(38) + '3c';
    const ids = (oids: string[]) => resolveMenu({ menu: 'commit', oid: oids[0]!, oids }).map((i) => i.id);
    // ancestor of HEAD: masked rebase-onto (nothing to rebase), visible interactive-rebase
    expect(ids(['0'.repeat(38) + '14'])).toContain('interactive-rebase');
    expect(ids(['0'.repeat(38) + '14'])).not.toContain('rebase-onto');
    // commit out of HEAD (full history loaded): rebase-onto visible, hidden interactive-rebase
    const stranger = '0'.repeat(37) + '3e7';
    expect(ids([stranger])).toContain('rebase-onto');
    expect(ids([stranger])).not.toContain('interactive-rebase');
    // multiple selection: neither
    expect(ids([head, '0'.repeat(38) + '14'])).not.toContain('interactive-rebase');
    expect(ids([head, '0'.repeat(38) + '14'])).not.toContain('rebase-onto');
  });
});

// - - - Actions of the banner
describe("Banner actions (op.continue / op.skip / op.abort)", () => {
  it("rebase: Continue calls rebase_continue [L] with an opId, then offers the undo \"rebased on\"", async () => {
    const fake = await openTestRepo({
      rebase_continue: () => ({ head: { branch: 'feature', oid: oid('f'), detached: false, unborn: false } }),
      undo_peek: () => {
        const u = makeUndo(true);
        return { ...u, entry: { ...u.entry!, kind: 'rebase' as const } };
      },
    });
    op.setState(makeConflictState({ conflictedPaths: [], step: 2, total: 3 }));
    await runAction('op.continue');
    await whenIdle();
    expect(fake.callsOf('rebase_continue')).toHaveLength(1);
    expect(typeof fake.callsOf('rebase_continue')[0]!.args.opId).toBe('string');
    await waitFor(() => expect(toast.items.some((t) => t.kind === 'undo')).toBe(true));
    expect(toast.items.find((t) => t.kind === 'undo')!.message).toBe("feature/login rebased onto main (3 commits)");
  });

  it("rebase : CANCELLED for a replay → « Stopping step: the rebase stays on pause. »", async () => {
    await openTestRepo({
      rebase_skip: () => {
        throw { code: 'CANCELLED', message: "cancelled", details: { opId: 'x' } };
      },
    });
    op.setState(makeConflictState());
    await runAction('op.skip');
    await whenIdle();
    expect(toast.items.at(-1)?.message).toBe("Stopping step: the rebase stays on pause.");
  });

  it("merge : Finish sends merge_continue with the default message", async () => {
    const fake = await openTestRepo({ merge_continue: () => ({ oid: oid('d') }) });
    op.setState(makeConflictState({ kind: 'merge', conflictedPaths: [], incoming: 'feature', step: null, total: null, headName: 'refs/heads/main' }));
    await runAction('op.continue');
    await whenIdle();
    expect(fake.callsOf('merge_continue')[0]!.args).toEqual({ repoId: 1, message: "Merge branch 'feature' into main" });
  });

  it("cherry-pick : Skip → sequencer_skip, without confirmation", async () => {
    const fake = await openTestRepo({ sequencer_skip: () => ({ head: { branch: 'main', oid: oid('e'), detached: false, unborn: false } }) });
    op.setState(makeConflictState({ kind: 'cherry-pick', step: 2, total: 3, headName: null, onto: null, ontoLabel: null }));
    await runAction('op.skip');
    await whenIdle();
    expect(fake.callsOf('sequencer_skip')).toHaveLength(1);
    expect(maybe('confirm-dialog')).toBeNull();
  });

  it("Abort: confirm-dialog[data-action=op-abort] then rebase_abort / merge_abort / sequencer_abort", async () => {
    const head = { head: { branch: 'main', oid: oid('9'), detached: false, unborn: false } };
    const fake = await openTestRepo({ rebase_abort: () => head, merge_abort: () => head, sequencer_abort: () => head });
    render(DialogHost);
    const cases: [ReturnType<typeof makeConflictState>, string][] = [
      [makeConflictState(), 'rebase_abort'],
      [makeConflictState({ kind: 'merge', step: null, total: null }), 'merge_abort'],
      [makeConflictState({ kind: 'revert', step: 1, total: 1 }), 'sequencer_abort'],
    ];
    for (const [state, command] of cases) {
      op.setState(state);
      const running = runAction('op.abort');
      const dlg = await screen.findByTestId('confirm-dialog');
      expect(dlg).toHaveAttribute('data-action', 'op-abort');
      expect(dlg).toHaveAttribute('data-danger', 'true');
      await userEvent.click(tid('confirm-dialog-confirm-btn'));
      await running;
      expect(fake.callsOf(command)).toHaveLength(1);
    }
  });

  it("Abort then cancel the confirmation: no orders", async () => {
    const fake = await openTestRepo();
    render(DialogHost);
    op.setState(makeConflictState());
    const running = runAction('op.abort');
    await screen.findByTestId('confirm-dialog');
    await userEvent.click(tid('confirm-dialog-cancel-btn'));
    await running;
    expect(fake.callsOf('rebase_abort')).toHaveLength(0);
  });

  it("sequencer: HEAD moved (abort without turning back) → toast dedicated information", async () => {
    const fake = await openTestRepo();
    render(DialogHost);
    // commits had been applied (step 3) and HEAD did not move after the abort: git cleaned without rewind.
    const headOid = repo.head!.oid!;
    fake.on('sequencer_abort', () => ({ head: { branch: 'main', oid: headOid, detached: false, unborn: false } }));
    op.setState(makeConflictState({ kind: 'cherry-pick', step: 3, total: 4 }));
    const running = runAction('op.abort');
    await screen.findByTestId('confirm-dialog');
    await userEvent.click(tid('confirm-dialog-confirm-btn'));
    await running;
    expect(toast.items.at(-1)?.message).toBe("HEAD moved during the operation: the state was cleaned up without resetting HEAD.");
  });

  it("sequencer: normal abort (HEAD back) → toast \"Abandoned operation\"", async () => {
    const fake = await openTestRepo({ sequencer_abort: () => ({ head: { branch: 'main', oid: oid('1'), detached: false, unborn: false } }) });
    render(DialogHost);
    expect(fake).toBeTruthy();
    op.setState(makeConflictState({ kind: 'cherry-pick', step: 3, total: 4 }));
    const running = runAction('op.abort');
    await screen.findByTestId('confirm-dialog');
    await userEvent.click(tid('confirm-dialog-confirm-btn'));
    await running;
    expect(toast.items.at(-1)?.message).toBe("Operation aborted");
  });
});

//
const HEAD_FEATURE = { head: { branch: 'feature', oid: oid('f'), detached: false, unborn: false } };
const AUTOSTASH_KEPT = "Your changes have been stored in a stash (stash@{0}).";
const infoMessages = () => toast.items.filter((t) => t.kind === 'info').map((t) => t.message);

describe("toast \"changes stored in a stash\" (autostash not re-applied)", () => {
  it("rebase simple: the list of stashes grew up after rebase_start { autostash: true }", async () => {
    let stashes = makeStashes().slice(0, 0);
    await openTestRepo({
      refs_list: () => refsOnFeature(),
      branch_compare: () => cmp({ dirty: true }),
      stash_list: () => stashes,
      rebase_start: () => {
        stashes = makeStashes().slice(0, 1); // Reapplication failed: git keeps stash
        return HEAD_FEATURE;
      },
    });
    render(DialogHost);
    void openDialog('rebase-confirm-dialog', { branch: null, target: 'main' });
    await screen.findByTestId('rebase-autostash-checkbox');
    await userEvent.click(tid('rebase-confirm-btn'));
    await whenIdle();
    await waitFor(() => expect(infoMessages()).toContain(AUTOSTASH_KEPT));
  });

  it("Simple rebase: autostash reapplied clean, no toast", async () => {
    await openTestRepo({
      refs_list: () => refsOnFeature(),
      branch_compare: () => cmp({ dirty: true }),
      rebase_start: () => HEAD_FEATURE,
    });
    render(DialogHost);
    void openDialog('rebase-confirm-dialog', { branch: null, target: 'main' });
    await screen.findByTestId('rebase-autostash-checkbox');
    await userEvent.click(tid('rebase-confirm-btn'));
    await whenIdle();
    expect(infoMessages()).not.toContain(AUTOSTASH_KEPT);
  });

  it("Interactive rebase: autostash checked, stash retained after rebase_interactive_start", async () => {
    let stashes: ReturnType<typeof makeStashes> = [];
    const dirtyFile = { path: 'a.txt', oldPath: null, staged: null, unstaged: 'modified' as const, conflict: null, oldMode: null, newMode: null, submodule: null, nonUtf8: null };
    await openPanel({
      status_get: () => makeStatus({ files: [dirtyFile] }),
      stash_list: () => stashes,
      rebase_interactive_start: () => {
        stashes = makeStashes().slice(0, 1);
        return HEAD_FEATURE;
      },
    });
    await userEvent.click(tid('rebase-todo-start-btn'));
    await whenIdle();
    await waitFor(() => expect(infoMessages()).toContain(AUTOSTASH_KEPT));
  });

  it("Continue: the stash already existed (RepoOpState.autostash) and remains in the list → toast", async () => {
    await openTestRepo({
      stash_list: () => makeStashes().slice(0, 1),
      rebase_continue: () => HEAD_FEATURE,
    });
    op.setState(makeConflictState({ conflictedPaths: [], autostash: true }));
    await runAction('op.continue');
    await whenIdle();
    expect(infoMessages()).toContain(AUTOSTASH_KEPT);
  });

  it("Skip : stash preserved → toast ; reapplied (list reduced) → no toast", async () => {
    let stashes = makeStashes().slice(0, 1);
    await openTestRepo({
      stash_list: () => stashes,
      rebase_skip: () => HEAD_FEATURE,
    });
    op.setState(makeConflictState({ autostash: true }));
    await runAction('op.skip');
    await whenIdle();
    expect(infoMessages()).toContain(AUTOSTASH_KEPT);

    toast.clear();
    stashes = makeStashes().slice(0, 1);
    await openTestRepo({ stash_list: () => stashes, rebase_skip: () => { stashes = []; return HEAD_FEATURE; } });
    op.setState(makeConflictState({ autostash: true }));
    await runAction('op.skip');
    await whenIdle();
    expect(infoMessages()).not.toContain(AUTOSTASH_KEPT);
  });

  it("Continue without autostash: never toast", async () => {
    await openTestRepo({ stash_list: () => makeStashes().slice(0, 1), rebase_continue: () => HEAD_FEATURE });
    op.setState(makeConflictState({ conflictedPaths: [], autostash: false }));
    await runAction('op.continue');
    await whenIdle();
    expect(infoMessages()).not.toContain(AUTOSTASH_KEPT);
  });
});

// ── Confirmation d'abandon (09, 07)

describe("text of confirm-dialog[data-action=op-abort]", () => {
  const st = (over: Parameters<typeof makeConflictState>[0]) => makeConflictState({ kind: 'cherry-pick', ...over });

  it("cherry-pick / revert: 2nd sentence only if there are already applied commits (N = step - 1)", () => {
    expect(abortConfirmMessage(st({ step: 1, total: 3 }))).toBe("Abort the cherry-pick?");
    expect(abortConfirmMessage(st({ step: 2, total: 3 }))).toBe("Abort the cherry-pick? The commit already applied by this operation will be removed.");
    expect(abortConfirmMessage(st({ step: 3, total: 3 }))).toBe("Abort the cherry-pick? The 2 commits already applied by this operation will be removed.");
    expect(abortConfirmMessage(st({ kind: 'revert', step: 4, total: 4 }))).toBe("Abort the revert? The 3 commits already applied by this operation will be removed.");
    expect(abortConfirmMessage(st({ step: null, total: null }))).toBe("Abort the cherry-pick?");
  });

  it("orphan (stale) condition: cleaning, no commit removed", () => {
    const text = abortConfirmMessage(st({ stopReason: 'stale', phase: 'stopped', step: 3, total: 3 }));
    expect(text).toBe("Clean up incomplete cherry-pick/revert state? No commits will be removed.");
    expect(text).not.toContain("withdrawn.");
  });

  it("rebase and merge: text of the base", () => {
    expect(abortConfirmMessage(makeConflictState())).toBe("Back to status before the rebase? Ongoing resolutions will be lost.");
    expect(abortConfirmMessage(makeConflictState({ kind: 'merge' }))).toBe("Back to the state before the merge? Ongoing resolutions will be lost.");
  });

  it("the dialog displays this text", async () => {
    await openTestRepo();
    render(DialogHost);
    op.setState(st({ step: 1, total: 2 }));
    const running = runAction('op.abort');
    const dlg = await screen.findByTestId('confirm-dialog');
    expect(dlg).toHaveTextContent("Abort the cherry-pick?");
    expect(dlg).not.toHaveTextContent("withdrawn");
    await userEvent.click(tid('confirm-dialog-cancel-btn'));
    await running;
  });
});

// "Alt+↑ / Alt+ю on the focused line "
describe("rebase-todo-panel : Alt+arrow from line", () => {
  const order = () => rowsOf().map((r) => r.getAttribute('data-oid'));

  it("the line itself has the focus: Alt+ю descends it, the focus follows it", async () => {
    await openPanel(undefined, [A, B, C]);
    row(A.oid).focus();
    expect(document.activeElement).toBe(row(A.oid));
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    await waitFor(() => expect(order()).toEqual([B, A, C].map((i) => i.oid)));
    await waitFor(() => expect(document.activeElement).toBe(row(A.oid)));
  });

  it("no effect when the focus is in the list of actions or in a message field", async () => {
    await openPanel(undefined, [A, B, C]);
    selectOf(B.oid).focus();
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(order()).toEqual([A, B, C].map((i) => i.oid));

    await userEvent.selectOptions(selectOf(C.oid), 'reword');
    const input = within(row(C.oid)).getByTestId('rebase-todo-message-input') as HTMLTextAreaElement;
    input.focus();
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(order()).toEqual([A, B, C].map((i) => i.oid));
  });
});

// ── Squash of selected commits

describe('squash', () => {
  // Test log_page: linear lines 60..1, HEAD = fxOid(60); 58 and 59 selected (in reverse click order), 60 rewritten above.
  const sq = (n: number, summary: string, pushed = false): TodoPreviewItem => ({
    oid: fxOid(n), shortOid: fxOid(n).slice(0, 7), summary, message: `${summary}\n\nbody`, author: 'Bot', pushed,
  });
  const squashPreview = (): TodoPreview => ({ base: fxOid(57), head: fxOid(60), items: [sq(58, 'A: adds a', true), sq(59, 'B: typo'), sq(60, 'C: adds c')] });
  const HEAD_MAIN = { head: { branch: 'main', oid: oid('e'), detached: false, unborn: false } };

  async function openSquash(extra: Record<string, () => unknown> = {}) {
    const fake = await openTestRepo({ rebase_todo_preview: () => squashPreview(), rebase_interactive_start: () => HEAD_MAIN, ...extra });
    render(DialogHost);
    graph.selectCommits([fxOid(59), fxOid(58)]);
    expect(await runAction('rebase.squash')).toBe(true);
    await screen.findByTestId('squash-message-input');
    return fake;
  }

  it("menu entry: visible for consecutive commits of HEAD only, plural label", async () => {
    await openTestRepo();
    const menu = (oids: string[]) => resolveMenu({ menu: 'commit', oid: oids[0]!, oids });
    const entry = menu([fxOid(59), fxOid(58)]).find((i) => i.id === 'squash');
    expect(entry?.label).toBe('Squash 2 commits...');
    expect(entry?.disabled).toBeFalsy();
    expect(menu([fxOid(59)]).map((i) => i.id)).not.toContain('squash');
    expect(menu([fxOid(59), fxOid(57)]).map((i) => i.id)).not.toContain('squash');
    // Action without target (multi-commit-squash-btn): graph selection, reason in the tooltip.
    graph.selectCommits([fxOid(59), fxOid(57)]);
    expect(actionDisabledReason(getAction('rebase.squash')!)).toBe('The selected commits must be consecutive.');
    graph.selectCommits([fxOid(59), fxOid(58)]);
    expect(actionDisabledReason(getAction('rebase.squash')!)).toBeNull();
    op.setState(makeConflictState());
    expect(menu([fxOid(59), fxOid(58)]).find((i) => i.id === 'squash')?.disabled).toBe(true);
  });

  it("dialog: preview from the parent of the oldest, pre-filled message, pushed warning, rewrite note, exact payload", async () => {
    const fake = await openSquash();
    expect(fake.callsOf('rebase_todo_preview')[0]!.args).toEqual({ repoId: 1, upstream: fxOid(57) });
    expect(screen.getAllByTestId('squash-commit-item').map((i) => i.getAttribute('data-oid'))).toEqual([fxOid(58), fxOid(59)]);
    const input = tid('squash-message-input') as HTMLTextAreaElement;
    expect(input.value).toBe('A: adds a\n\nB: typo');
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(tid('squash-pushed-warning')).toHaveTextContent('1 of these commits is already on a remote.');
    expect(tid('squash-rewrite-note')).toHaveTextContent('1 later commit will be rewritten as well.');
    expect(maybe('squash-autostash-checkbox')).toBeNull();

    await fireEvent.input(input, { target: { value: '  ' } });
    expect(tid('squash-confirm-btn')).toBeDisabled();
    await fireEvent.input(input, { target: { value: 'A: adds a and b' } });
    await userEvent.click(tid('squash-confirm-btn'));
    await waitFor(() => expect(fake.callsOf('rebase_interactive_start')).toHaveLength(1));
    const args = fake.callsOf('rebase_interactive_start')[0]!.args;
    expect(args).toMatchObject({ repoId: 1, upstream: fxOid(57), expectedHead: fxOid(60), autostash: false });
    expect(typeof args.opId).toBe('string');
    expect(args.todo).toEqual([
      { oid: fxOid(58), action: 'pick' },
      { oid: fxOid(59), action: 'squash', message: 'A: adds a and b' },
      { oid: fxOid(60), action: 'pick' },
    ]);
    await whenIdle();
    expect(graph.selection.kind).toBe('none');
    expect(maybe('squash-dialog')).toBeNull();
  });

  it("lines not loaded: order and base read by commit_details", async () => {
    const parents: Record<string, string> = { [oid('b')]: oid('a'), [oid('c')]: oid('b') };
    const fake = await openTestRepo({
      commit_details: (a) => ({ oid: a.oid, parents: [parents[String(a.oid)]], message: 'x' }),
      rebase_todo_preview: () => ({ base: oid('a'), head: oid('c'), items: [item(1, 'B', { oid: oid('b') }), item(2, 'C', { oid: oid('c') })] }),
    });
    render(DialogHost);
    void openDialog('squash-dialog', { oids: [oid('c'), oid('b')] });
    expect(((await screen.findByTestId('squash-message-input')) as HTMLTextAreaElement).value).toBe('B\n\nC');
    expect(fake.callsOf('rebase_todo_preview')[0]!.args).toEqual({ repoId: 1, upstream: oid('a') });
    expect(maybe('squash-rewrite-note')).toBeNull();
    expect(tid('squash-confirm-btn')).toBeEnabled();
  });

  it("lines not loaded, commit_details fails: inline error instead of an empty dialog", async () => {
    const fake = await openTestRepo({
      commit_details: () => {
        throw { code: 'NOT_FOUND', message: 'gone' };
      },
    });
    render(DialogHost);
    void openDialog('squash-dialog', { oids: [oid('c'), oid('b')] });
    expect(await screen.findByTestId('squash-error')).toHaveTextContent('Could not read the selected commits.');
    expect(maybe('squash-loading')).toBeNull();
    expect(tid('squash-confirm-btn')).toBeDisabled();
    expect(fake.callsOf('rebase_todo_preview')).toHaveLength(0);
  });

  it("lines not loaded, chain on another branch: not-in-head reason, not STALE", async () => {
    const parents: Record<string, string> = { [oid('b')]: oid('a'), [oid('c')]: oid('b') };
    await openTestRepo({
      commit_details: (a) => ({ oid: a.oid, parents: [parents[String(a.oid)]], message: 'x' }),
      // `a..HEAD` does not contain the selected side-branch commits.
      rebase_todo_preview: () => ({ base: oid('a'), head: oid('e'), items: [item(1, 'D', { oid: oid('d') }), item(2, 'E', { oid: oid('e') })] }),
    });
    render(DialogHost);
    void openDialog('squash-dialog', { oids: [oid('c'), oid('b')] });
    expect(await screen.findByTestId('squash-error')).toHaveTextContent('The selected commits do not belong to the current branch.');
    expect(tid('squash-confirm-btn')).toBeDisabled();
  });

  it("UNSUPPORTED_MERGES from the preview: inline error, confirmation disabled", async () => {
    await openTestRepo({
      rebase_todo_preview: () => {
        throw { code: 'UNSUPPORTED_MERGES', message: 'merges', details: { oids: [fxOid(59)] } };
      },
    });
    render(DialogHost);
    void openDialog('squash-dialog', { oids: [fxOid(58), fxOid(59)] });
    expect(await screen.findByTestId('squash-error')).toHaveTextContent('Range containing merges: not supported in v1.');
    expect(tid('squash-confirm-btn')).toBeDisabled();
    expect(toast.items).toHaveLength(0);
  });

  it("STALE: dedicated toast", async () => {
    await openSquash({
      rebase_interactive_start: () => {
        throw { code: 'STALE', message: 'expired', details: { what: 'todo' } };
      },
    });
    await userEvent.click(tid('squash-confirm-btn'));
    await whenIdle();
    await waitFor(() => expect(toast.items.at(-1)?.message).toBe('The branch changed since the selection: nothing was squashed. Select the commits again.'));
  });

  it("DIRTY_WORKTREE: the dialog reopens with the typed message, retry with autostash", async () => {
    let n = 0;
    const fake = await openSquash({
      rebase_interactive_start: () => {
        if (n++ === 0) throw { code: 'DIRTY_WORKTREE', message: 'sale', details: { paths: ['README.md'] } };
        return HEAD_MAIN;
      },
    });
    await fireEvent.input(tid('squash-message-input'), { target: { value: 'Typed message' } });
    await userEvent.click(tid('squash-confirm-btn'));
    await screen.findByTestId('squash-dirty');
    await waitFor(() => expect((tid('squash-message-input') as HTMLTextAreaElement).value).toBe('Typed message'));
    await userEvent.click(tid('squash-confirm-btn'));
    await waitFor(() => expect(fake.callsOf('rebase_interactive_start')).toHaveLength(2));
    expect(fake.callsOf('rebase_interactive_start')[1]!.args).toMatchObject({ autostash: true });
    expect((fake.callsOf('rebase_interactive_start')[1]!.args.todo as { message?: string }[])[1]!.message).toBe('Typed message');
  });

  it("CONFLICT: banner of the base (operation state), no toast", async () => {
    await openSquash({
      rebase_interactive_start: () => {
        throw { code: 'CONFLICT', message: 'conflit', details: { state: makeConflictState() } };
      },
    });
    await userEvent.click(tid('squash-confirm-btn'));
    await waitFor(() => expect(op.state?.kind).toBe('rebase'));
    expect(toast.items).toHaveLength(0);
  });
});

// - - - Skip: backup announced, confirmation only where Skip would reset work without a conflict to skip
describe("op.skip: Recover toast and op-skip confirmation", () => {
  const SKIP_TOAST = (n: number) => (n === 1 ? 'Saved 1 file before skipping.' : `Saved ${n} files before skipping.`);
  const skipToast = (n: number) => toast.items.find((t) => t.message === SKIP_TOAST(n));
  const stopped = (over: Partial<ReturnType<typeof makeConflictState>> = {}) =>
    makeConflictState({ phase: 'stopped', stopReason: 'blocked', conflictedPaths: [], ...over });

  it("rebase_skip answers backedUp: Recover toast (opens the trash), next to the end-of-rebase undo toast", async () => {
    await openTestRepo({
      rebase_skip: () => ({ ...HEAD_FEATURE, backedUp: 2 }),
      undo_peek: () => {
        const u = makeUndo(true);
        return { ...u, entry: { ...u.entry!, kind: 'rebase' as const } };
      },
    });
    op.setState(makeConflictState());
    await runAction('op.skip');
    await whenIdle();
    const saved = skipToast(2);
    expect(saved?.actions.map((a) => a.testid)).toEqual(['toast-recover-btn']);
    await waitFor(() => expect(toast.items.some((t) => t.kind === 'undo')).toBe(true));
    expect(toast.items).toContain(saved);
    await saved!.actions[0]!.run();
    expect(ui.drawer).toBe('discard-trash-panel');
  });

  it("no backedUp (nothing saved): no Recover toast", async () => {
    await openTestRepo({ rebase_skip: () => ({ ...HEAD_FEATURE, backedUp: null }) });
    op.setState(makeConflictState());
    await runAction('op.skip');
    await whenIdle();
    expect(toast.items.some((t) => t.message.includes('before skipping'))).toBe(false);
  });

  it("a new stop (CONFLICT) or a cancellation carries details.backedUp: the Recover toast still shows", async () => {
    await openTestRepo({
      rebase_skip: () => {
        throw { code: 'CONFLICT', message: 'The operation stopped', details: { state: stopped(), backedUp: 1 } };
      },
    });
    op.setState(makeConflictState());
    await runAction('op.skip');
    await whenIdle();
    expect(skipToast(1)).toBeDefined();

    toast.clear();
    await openTestRepo({
      rebase_skip: () => {
        throw { code: 'CANCELLED', message: 'cancelled', details: { opId: 'x', backedUp: 3 } };
      },
    });
    op.setState(makeConflictState());
    await runAction('op.skip');
    await whenIdle();
    expect(skipToast(3)).toBeDefined();
    expect(toast.items.some((t) => t.message === "Stopping step: the rebase stays on pause.")).toBe(true);
  });

  it("cherry-pick: backedUp on success; DIRTY_WORKTREE names the path and announces nothing", async () => {
    const pickState = makeConflictState({ kind: 'cherry-pick', step: 1, total: 1, headName: null, onto: null, ontoLabel: null });
    const fake = await openTestRepo({ sequencer_skip: () => ({ head: { branch: 'main', oid: oid('e'), detached: false, unborn: false }, backedUp: 1 }) });
    op.setState(pickState);
    await runAction('op.skip');
    await whenIdle();
    expect(fake.callsOf('sequencer_skip')).toHaveLength(1);
    expect(skipToast(1)).toBeDefined();

    toast.clear();
    await openTestRepo({
      sequencer_skip: () => {
        throw { code: 'DIRTY_WORKTREE', message: 'These files have staged and unstaged changes: stage or discard them before skipping.', details: { paths: ['c.txt'] } };
      },
    });
    op.setState(pickState);
    await runAction('op.skip');
    await whenIdle();
    expect(toast.items.at(-1)?.message).toContain('c.txt');
    expect(toast.items.some((t) => t.actions.some((a) => a.testid === 'toast-recover-btn'))).toBe(false);
  });

  it("rebase stopped without conflict and tracked changes: confirm-dialog[data-action=op-skip]; Cancel sends nothing", async () => {
    const fake = await openTestRepo({ rebase_skip: () => HEAD_FEATURE });
    render(DialogHost);
    status.apply(makeStatus());
    op.setState(stopped());
    const running = runAction('op.skip');
    const dlg = await screen.findByTestId('confirm-dialog');
    expect(dlg).toHaveAttribute('data-action', 'op-skip');
    expect(dlg).toHaveAttribute('data-danger', 'true');
    expect(dlg).toHaveTextContent('use Continue');
    await userEvent.click(tid('confirm-dialog-cancel-btn'));
    await running;
    expect(fake.callsOf('rebase_skip')).toHaveLength(0);

    const again = runAction('op.skip');
    await screen.findByTestId('confirm-dialog');
    await userEvent.click(tid('confirm-dialog-confirm-btn'));
    await again;
    await whenIdle();
    expect(fake.callsOf('rebase_skip')).toHaveLength(1);
  });

  it("no confirmation at a conflict stop, nor at a stop whose tracked files are clean", async () => {
    const fake = await openTestRepo({ rebase_skip: () => HEAD_FEATURE });
    render(DialogHost);
    status.apply(makeStatus());
    op.setState(makeConflictState());
    await runAction('op.skip');
    await whenIdle();
    expect(maybe('confirm-dialog')).toBeNull();

    status.apply(makeStatus({ files: makeStatus().files.filter((f) => f.unstaged === 'untracked') }));
    op.setState(stopped({ stopReason: 'empty' }));
    await runAction('op.skip');
    await whenIdle();
    expect(maybe('confirm-dialog')).toBeNull();
    expect(fake.callsOf('rebase_skip')).toHaveLength(2);
  });

  it("skipNeedsConfirm: rebase stop without conflicted paths, with a tracked change (staged, unstaged or conflicted; not untracked nor submodule)", () => {
    const [staged, unstaged, untracked] = makeStatus().files as [FileStatus, FileStatus, FileStatus];
    const st = stopped();
    expect(skipNeedsConfirm(st, [staged])).toBe(true);
    expect(skipNeedsConfirm(st, [unstaged])).toBe(true);
    expect(skipNeedsConfirm(st, [untracked])).toBe(false);
    expect(skipNeedsConfirm(st, [{ ...unstaged, submodule: true }])).toBe(false);
    expect(skipNeedsConfirm(st, [])).toBe(false);
    expect(skipNeedsConfirm(makeConflictState(), [staged])).toBe(false);
    // `edit` stop with a staged amendment: git reports `conflict`, but nothing is in conflict.
    expect(skipNeedsConfirm(makeConflictState({ conflictedPaths: [] }), [staged])).toBe(true);
    expect(skipNeedsConfirm(makeConflictState({ phase: 'running', conflictedPaths: [] }), [staged])).toBe(false);
    expect(skipNeedsConfirm(stopped({ kind: 'cherry-pick' }), [staged])).toBe(false);
  });
});

// ── Edit the message of one commit (reword)

describe('reword', () => {
  // Test log_page: linear lines 60..1, HEAD = fxOid(60). Commit 59 reworded (upstream 58), 60 rewritten above it.
  const rw = (n: number, message: string, pushed = false): TodoPreviewItem => ({
    oid: fxOid(n), shortOid: fxOid(n).slice(0, 7), summary: message.split('\n')[0]!, message, author: 'Bot', pushed,
  });
  const rewordPreview = (): TodoPreview => ({ base: fxOid(58), head: fxOid(60), items: [rw(59, 'B: typo\n\nThe body.', true), rw(60, 'C: adds c')] });
  const HEAD_MAIN = { head: { branch: 'main', oid: fxOid(60), detached: false, unborn: false } };
  const menu = (oids: string[]) => resolveMenu({ menu: 'commit', oid: oids[0]!, oids });

  async function openReword(extra: Record<string, () => unknown> = {}) {
    const fake = await openTestRepo({ rebase_todo_preview: () => rewordPreview(), rebase_interactive_start: () => HEAD_MAIN, ...extra });
    render(DialogHost);
    void menu([fxOid(59)]).find((i) => i.id === 'reword')!.run();
    await screen.findByTestId('reword-summary-input');
    return fake;
  }

  it("menu entry: one commit of HEAD's history only, disabled while an operation blocks writes; palette action on the selection", async () => {
    await openTestRepo();
    const entry = menu([fxOid(59)]).find((i) => i.id === 'reword');
    expect(entry?.label).toBe('Edit message...');
    expect(entry?.disabled).toBeFalsy();
    expect(menu([fxOid(59), fxOid(58)]).map((i) => i.id)).not.toContain('reword');
    // Action (palette, details panel): the single selected commit; not applicable = disabled without a reason (not listed).
    const action = getAction('commit.reword')!;
    expect(action.palette).not.toBe(false);
    expect(actionDisabledReason(action)).toBe('');
    graph.selectCommit(fxOid(59));
    expect(actionDisabledReason(action)).toBeNull();
    graph.selectCommits([fxOid(59), fxOid(58)]);
    expect(actionDisabledReason(action)).toBe('');
    graph.selectCommit(fxOid(59));
    op.setState(makeConflictState());
    expect(menu([fxOid(59)]).find((i) => i.id === 'reword')?.disabled).toBe(true);
    expect(actionDisabledReason(action)).toBeTruthy();
  });

  it("menu entry hidden in detached HEAD", async () => {
    const r = makeRefs();
    await openTestRepo({ refs_list: () => ({ ...r, head: { kind: 'detached', oid: fxOid(60) }, local: r.local.map((b) => ({ ...b, isHead: false })) }) });
    expect(menu([fxOid(59)]).map((i) => i.id)).not.toContain('reword');
  });

  it("dialog: pre-filled summary and description, Save disabled while unchanged or empty, notes, exact payload, rewritten commit selected", async () => {
    const fake = await openReword();
    expect(fake.callsOf('rebase_todo_preview')[0]!.args).toEqual({ repoId: 1, upstream: fxOid(58) });
    const summary = tid('reword-summary-input') as HTMLInputElement;
    const body = tid('reword-description-input') as HTMLTextAreaElement;
    expect(summary.value).toBe('B: typo');
    expect(body.value).toBe('The body.');
    await waitFor(() => expect(document.activeElement).toBe(summary));
    expect(tid('reword-commit')).toHaveAttribute('data-oid', fxOid(59));
    expect(tid('reword-rewrite-note')).toHaveTextContent('1 later commit will be rewritten as well.');
    expect(tid('reword-pushed-warning')).toHaveTextContent('1 of the rewritten commits is already on a remote.');
    expect(maybe('reword-autostash-checkbox')).toBeNull();
    expect(tid('reword-confirm-btn')).toBeDisabled();
    expect(tid('reword-confirm-btn')).toHaveAttribute('title', 'The message is unchanged.');

    await fireEvent.input(summary, { target: { value: '   ' } });
    expect(tid('reword-confirm-btn')).toBeDisabled();
    await fireEvent.input(summary, { target: { value: 'B: fix the typo ' } });
    await fireEvent.input(body, { target: { value: 'The body.\nSecond line.\n' } });
    expect(tid('reword-confirm-btn')).toBeEnabled();
    await userEvent.click(tid('reword-confirm-btn'));
    await waitFor(() => expect(fake.callsOf('rebase_interactive_start')).toHaveLength(1));
    const args = fake.callsOf('rebase_interactive_start')[0]!.args;
    expect(args).toMatchObject({ repoId: 1, upstream: fxOid(58), expectedHead: fxOid(60), autostash: false });
    expect(typeof args.opId).toBe('string');
    expect(args.todo).toEqual([
      { oid: fxOid(59), action: 'reword', message: 'B: fix the typo\n\nThe body.\nSecond line.' },
      { oid: fxOid(60), action: 'pick' },
    ]);
    await whenIdle();
    expect(maybe('reword-dialog')).toBeNull();
    // The new oid of the commit: oldest of `upstream..HEAD` read again after the rebase.
    expect(fake.callsOf('rebase_todo_preview')).toHaveLength(2);
    expect(graph.singleCommitOid).toBe(fxOid(59));
  });

  it("dirty worktree: autostash checkbox checked by default and sent", async () => {
    const fake = await openReword({ status_get: () => makeStatus() });
    expect(tid('reword-autostash-checkbox')).toBeChecked();
    await fireEvent.input(tid('reword-summary-input'), { target: { value: 'B: other' } });
    await userEvent.click(tid('reword-confirm-btn'));
    await waitFor(() => expect(fake.callsOf('rebase_interactive_start')).toHaveLength(1));
    expect(fake.callsOf('rebase_interactive_start')[0]!.args).toMatchObject({ autostash: true });
  });

  it("UNSUPPORTED_MERGES from the preview: inline error, Save disabled", async () => {
    await openTestRepo({
      rebase_todo_preview: () => {
        throw { code: 'UNSUPPORTED_MERGES', message: 'merges', details: { oids: [fxOid(59)] } };
      },
    });
    render(DialogHost);
    void openDialog('reword-dialog', { oid: fxOid(59) });
    expect(await screen.findByTestId('reword-error')).toHaveTextContent('Range containing merges: not supported in v1.');
    expect(tid('reword-confirm-btn')).toBeDisabled();
  });

  it("line not loaded, commit off the current branch: not-in-head reason", async () => {
    await openTestRepo({
      commit_details: (a) => ({ oid: a.oid, parents: [oid('a')], message: 'x' }),
      rebase_todo_preview: () => ({ base: oid('a'), head: oid('e'), items: [item(1, 'D', { oid: oid('d') }), item(2, 'E', { oid: oid('e') })] }),
    });
    render(DialogHost);
    void openDialog('reword-dialog', { oid: oid('b') });
    expect(await screen.findByTestId('reword-error')).toHaveTextContent("This commit is not on the current branch's history.");
    expect(tid('reword-confirm-btn')).toBeDisabled();
  });

  it("STALE: dedicated toast", async () => {
    await openReword({
      rebase_interactive_start: () => {
        throw { code: 'STALE', message: 'expired', details: { what: 'todo' } };
      },
    });
    await fireEvent.input(tid('reword-summary-input'), { target: { value: 'B: other' } });
    await userEvent.click(tid('reword-confirm-btn'));
    await whenIdle();
    await waitFor(() => expect(toast.items.at(-1)?.message).toBe('The branch changed since the dialog opened: the message was not changed. Try again.'));
  });

  it("DIRTY_WORKTREE: the dialog reopens with the typed text, retry with autostash", async () => {
    let n = 0;
    const fake = await openReword({
      rebase_interactive_start: () => {
        if (n++ === 0) throw { code: 'DIRTY_WORKTREE', message: 'dirty', details: { paths: ['README.md'] } };
        return HEAD_MAIN;
      },
    });
    await fireEvent.input(tid('reword-summary-input'), { target: { value: 'Typed summary' } });
    await fireEvent.input(tid('reword-description-input'), { target: { value: 'Typed body' } });
    await userEvent.click(tid('reword-confirm-btn'));
    await screen.findByTestId('reword-dirty');
    await waitFor(() => expect((tid('reword-summary-input') as HTMLInputElement).value).toBe('Typed summary'));
    expect((tid('reword-description-input') as HTMLTextAreaElement).value).toBe('Typed body');
    await userEvent.click(tid('reword-confirm-btn'));
    await waitFor(() => expect(fake.callsOf('rebase_interactive_start')).toHaveLength(2));
    expect(fake.callsOf('rebase_interactive_start')[1]!.args).toMatchObject({ autostash: true });
    expect((fake.callsOf('rebase_interactive_start')[1]!.args.todo as { message?: string }[])[0]!.message).toBe('Typed summary\n\nTyped body');
  });

  it("CONFLICT (e.g. commit-msg hook refusing the message): banner of the base, no toast", async () => {
    await openReword({
      rebase_interactive_start: () => {
        throw { code: 'CONFLICT', message: 'blocked', details: { state: makeConflictState() } };
      },
    });
    await fireEvent.input(tid('reword-summary-input'), { target: { value: 'B: other' } });
    await userEvent.click(tid('reword-confirm-btn'));
    await waitFor(() => expect(op.state?.kind).toBe('rebase'));
    expect(toast.items).toHaveLength(0);
  });
});
