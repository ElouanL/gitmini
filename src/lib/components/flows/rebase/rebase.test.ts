// "rebase" stream (07): `rebase-confirm-dialog`, `rebase-todo-panel`, menu entries, banner actions.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { whenIdle } from '$lib/activity';
import { abortConfirmMessage } from './banner-actions';
import { runAction } from '$lib/actions/registry';
import DialogHost from '$lib/components/dialogs-base/DialogHost.svelte';
import '$lib/components/dialogs-base/register';
import { openDialog, preloadDialog } from '$lib/dialogs/registry';
import type { BranchCompare, TodoPreview, TodoPreviewItem } from '$lib/ipc/types';
import { resolveMenu } from '$lib/menus/registry';
import { graph } from '$lib/stores/graph.svelte';
import { op } from '$lib/stores/op.svelte';
import { repo } from '$lib/stores/repo.svelte';
import { toast } from '$lib/stores/toast.svelte';
import { ui } from '$lib/stores/ui.svelte';
import { makeBranch, makeConflictState, makeRefs, makeStashes, makeStatus, makeUndo } from '$lib/test/fixtures';
import { resetAll } from '$lib/test/reset';
import { openTestRepo, oid } from '../test-support';
import '$lib/register-core';
import './register';
import RebaseTodoPanel from './RebaseTodoPanel.svelte';

const tid = (id: string) => screen.getByTestId(id);
const maybe = (id: string) => screen.queryByTestId(id);

// The dialogues are in lazy loading: they are downloaded once (the first dynamic import of a chunk is slow under vitest).
beforeAll(async () => {
  await Promise.all(['rebase-confirm-dialog'].map((id) => preloadDialog(id)));
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
