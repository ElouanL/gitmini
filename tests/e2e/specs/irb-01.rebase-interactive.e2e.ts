// IRB-01 — Squash with message, fixup, reorder, reword (, 07). Fixture `rebase-interactive`, HEAD on feature.
// feature = A, B (typo), C, fixup! A, D (from the oldest to the most recent).
import { $, browser, expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { dragPointer, type Point, type Rect } from '../../support/graph';
import { commitMessage, logSubjects, revParse } from '../../support/git-state';
import { appReady, chooseContextItem, click, countOf, idle, rightClick, tid, until, waitForGone, waitForTestId } from '../../support/ui';

const rowSel = (oid: string): string => tid('rebase-todo-row', { oid });
const inRow = (oid: string, id: string) => $(`${rowSel(oid)} ${tid(id)}`);

async function rectOf(selector: string): Promise<Rect> {
  return browser.execute((sel: string) => {
    const r = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, selector);
}

/** Slides the handle of the `oid` line on the low half (`below`) or high half of the `target` line (Pointer Actual Events). */
async function dragRow(oid: string, target: string, where: 'below' | 'above'): Promise<void> {
  const handle = await rectOf(`${rowSel(oid)} ${tid('rebase-todo-drag-handle')}`);
  const row = await rectOf(rowSel(target));
  const from: Point = { x: Math.round(handle.x + handle.width / 2), y: Math.round(handle.y + handle.height / 2) };
  const to: Point = { x: from.x, y: Math.round(where === 'below' ? row.y + row.height - 4 : row.y + 4) };
  await dragPointer(from, to);
}

const order = (): Promise<string[]> =>
  browser.execute(() => Array.from(document.querySelectorAll('[data-testid="rebase-todo-row"]')).map((r) => r.getAttribute('data-oid') ?? ''));

describe("IRB-01 — Interactive rebase: squash, fixup, reordering, reword", () => {
  it("IRB-01 — fixup under A, B squash with final message, D before C, C word: history and exact messages", async () => {
    const { repo } = currentSession();
    await appReady();
    const [A, B, C, FX, D] = ['feature~4', 'feature~3', 'feature~2', 'feature~1', 'feature'].map((rev) => revParse(repo, rev));
    const treeBefore = revParse(repo, 'feature^{tree}');

    await rightClick('sidebar-branch-item', { ref: 'refs/heads/main' });
    await chooseContextItem('interactive-rebase-onto');
    await waitForTestId('rebase-todo-panel');
    await until(async () => (await countOf('rebase-todo-row')) === 5, { message: 'rebase-todo-panel devrait lister 5 commits' });
    expect(await order()).toEqual([A, B, C, FX, D]);

    // 1. "fixup! A" → fixup, slipped just under A.
    await (await inRow(FX, 'rebase-todo-action-select')).selectByAttribute('value', 'fixup');
    await dragRow(FX, A, 'below');
    await until(async () => (await order()).join() === [A, FX, B, C, D].join(), { message: "the fixup should be on A" });

    // 2. B → squash: the last member of the A+fixup+B group, it carries the final message (pre-filled: A and B messages).
    await (await inRow(B, 'rebase-todo-action-select')).selectByAttribute('value', 'squash');
    const groupInput = await inRow(B, 'rebase-todo-message-input');
    await groupInput.waitForDisplayed();
    expect(await groupInput.getValue()).toContain("A: adds a.txt");
    await groupInput.setValue("A: adds a.txt\n\nInclut la correction B.");

    // 3. D slid C above.
    await dragRow(D, C, 'above');
    await until(async () => (await order()).join() === [A, FX, B, D, C].join(), { message: "D should be before C" });

    // 4. C → reword with a new message.
    await (await inRow(C, 'rebase-todo-action-select')).selectByAttribute('value', 'reword');
    const rewordInput = await inRow(C, 'rebase-todo-message-input');
    await rewordInput.waitForDisplayed();
    await rewordInput.setValue("C: adds c.txt (renamed)");

    // 5. Lancer.
    await click('rebase-todo-start-btn');
    await idle();
    await waitForGone('rebase-todo-panel');

    expect(logSubjects(repo, 'main..feature')).toEqual(["C: adds c.txt (renamed)", "D: adds d.txt", "A: adds a.txt"]);
    expect(commitMessage(repo, 'feature')).toBe("C: adds c.txt (renamed)\n");
    expect(commitMessage(repo, 'feature~2')).toBe("A: adds a.txt\n\nInclut la correction B.\n");
    expect(revParse(repo, 'feature^{tree}')).toBe(treeBefore); // the final tree is the one before
  });
});
