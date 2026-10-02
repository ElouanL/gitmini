import { describe, expect, it } from 'vitest';
import type { TodoAction, TodoPreviewItem } from '$lib/ipc/types';
import { buildRows, isUnchanged, summarize, toTodoItems, validateTodo, type TodoEdits } from './todo';

const item = (n: number, summary: string, message = summary): TodoPreviewItem => ({
  oid: n.toString(16).padStart(40, '0'), shortOid: n.toString(16).padStart(7, '0'), summary, message, author: 'Bot', pushed: false,
});

// Fixture `rebase-interactive` : A, B (typo), C, fixup! A, D — from the oldest to the most recent.
const A = item(1, "A: adds a.txt");
const B = item(2, 'B: typo');
const C = item(3, "C: adds c.txt");
const FX = item(4, "fixup! A: add a.txt");
const D = item(5, "D: adds d.txt");
const ORIGINAL = [A, B, C, FX, D];

const none: TodoEdits = { reword: {}, group: {} };
const acts = (m: Record<string, TodoAction> = {}) => m;

describe('buildRows', () => {
  it("all lines are default picks, without message field", () => {
    const rows = buildRows(ORIGINAL, acts(), none);
    expect(rows.map((r) => r.action)).toEqual(['pick', 'pick', 'pick', 'pick', 'pick']);
    expect(rows.every((r) => r.field === null && r.joins === null && r.members === 0)).toBe(true);
  });

  it("a reword carries a pre-filled field with the original message", () => {
    const rows = buildRows(ORIGINAL, acts({ [C.oid]: 'reword' }), none);
    const c = rows[2]!;
    expect(c.field).toEqual({ kind: 'reword', initial: "C: adds c.txt", value: "C: adds c.txt", edited: false });
    const edited = buildRows(ORIGINAL, acts({ [C.oid]: 'reword' }), { reword: { [C.oid]: "C renamed" }, group: {} })[2]!;
    expect(edited.field).toMatchObject({ value: "C renamed", edited: true });
  });

  it("IRB-01 : A + fixup + B(squash) form a group whose last member carries the message", () => {
    const order = [A, FX, B, D, C];
    const rows = buildRows(order, acts({ [FX.oid]: 'fixup', [B.oid]: 'squash', [C.oid]: 'reword' }), none);
    const [a, fx, b] = rows;
    expect(a!.members).toBe(2);
    expect(fx!.joins).toBe(A.oid);
    expect(fx!.lastOfGroup).toBe(false);
    expect(fx!.field).toBeNull();
    expect(b!.joins).toBe(A.oid);
    expect(b!.lastOfGroup).toBe(true);
    // pre-filling: pick message + squash messages (fixup is ignored)
    expect(b!.field).toEqual({ kind: 'group', initial: "A: adds a.txt\n\nB: typo", value: "A: adds a.txt\n\nB: typo", edited: false });
  });

  it("a group message entered is retained as long as the head remains the same", () => {
    const rows = buildRows([A, B], acts({ [B.oid]: 'squash' }), { reword: {}, group: { [A.oid]: "A: adds a.txt\n\nInclut la correction B." } });
    expect(rows[1]!.field).toMatchObject({ kind: 'group', edited: true, value: "A: adds a.txt\n\nInclut la correction B." });
  });

  it("a squash after a drop joins the previous pick", () => {
    const rows = buildRows([A, B, C], acts({ [B.oid]: 'drop', [C.oid]: 'squash' }), none);
    expect(rows[2]!.joins).toBe(A.oid);
    expect(rows[0]!.members).toBe(1);
    expect(rows[1]!.joins).toBeNull();
  });

  it("a squash in the front line does not reach anything", () => {
    const rows = buildRows([A, B], acts({ [A.oid]: 'squash' }), none);
    expect(rows[0]!.joins).toBeNull();
    expect(rows[0]!.field).toBeNull();
  });
});

describe('validateTodo (07 « Rebase interactif », 01 §5.3)', () => {
  it("valid list", () => {
    expect(validateTodo(buildRows(ORIGINAL, acts(), none))).toBeNull();
  });
  it('all-dropped', () => {
    const all = Object.fromEntries(ORIGINAL.map((i) => [i.oid, 'drop' as const]));
    expect(validateTodo(buildRows(ORIGINAL, all, none))).toBe('all-dropped');
  });
  it("first-is-squash: the first line is squash or fixup", () => {
    expect(validateTodo(buildRows(ORIGINAL, acts({ [A.oid]: 'squash' }), none))).toBe('first-is-squash');
    expect(validateTodo(buildRows(ORIGINAL, acts({ [A.oid]: 'drop', [B.oid]: 'fixup' }), none))).toBe('first-is-squash');
  });
  it("empty-message: empty reword, or empty group message", () => {
    expect(validateTodo(buildRows(ORIGINAL, acts({ [C.oid]: 'reword' }), { reword: { [C.oid]: '   ' }, group: {} }))).toBe('empty-message');
    expect(validateTodo(buildRows([A, B], acts({ [B.oid]: 'squash' }), { reword: {}, group: { [A.oid]: '' } }))).toBe('empty-message');
  });
});

describe('toTodoItems', () => {
  it("IRB-01: Reword with message, group with final message carried by the last member, order retained", () => {
    const order = [A, FX, B, D, C];
    const rows = buildRows(order, acts({ [FX.oid]: 'fixup', [B.oid]: 'squash', [C.oid]: 'reword' }), {
      reword: { [C.oid]: "C: adds c.txt (renamed)" },
      group: { [A.oid]: "A: adds a.txt\n\nInclut la correction B." },
    });
    expect(toTodoItems(rows)).toEqual([
      { oid: A.oid, action: 'pick' },
      { oid: FX.oid, action: 'fixup' },
      { oid: B.oid, action: 'squash', message: "A: adds a.txt\n\nInclut la correction B." },
      { oid: D.oid, action: 'pick' },
      { oid: C.oid, action: 'reword', message: "C: adds c.txt (renamed)" },
    ]);
  });

  it("a group message left as pre-filled is not sent (git combines itself)", () => {
    const rows = buildRows([A, B], acts({ [B.oid]: 'squash' }), none);
    expect(toTodoItems(rows)).toEqual([{ oid: A.oid, action: 'pick' }, { oid: B.oid, action: 'squash' }]);
  });

  it("drop and pick", () => {
    const rows = buildRows([A, B], acts({ [B.oid]: 'drop' }), none);
    expect(toTodoItems(rows)).toEqual([{ oid: A.oid, action: 'pick' }, { oid: B.oid, action: 'drop' }]);
  });

  it("a reword head that receives a squash is sent as a pick (the message of the bonus group)", () => {
    const rows = buildRows([A, B], acts({ [A.oid]: 'reword', [B.oid]: 'fixup' }), { reword: {}, group: { [A.oid]: 'nouveau' } });
    expect(toTodoItems(rows)).toEqual([{ oid: A.oid, action: 'pick' }, { oid: B.oid, action: 'fixup', message: 'nouveau' }]);
  });
});

describe("summarize and isUnchanged", () => {
  it("5 commits → 3 commits (groupe de 3) ; 1 deleted", () => {
    const rows = buildRows([A, FX, B, D, C], acts({ [FX.oid]: 'fixup', [B.oid]: 'squash', [C.oid]: 'drop' }), none);
    expect(summarize(rows)).toEqual({ before: 5, after: 2, dropped: 1 });
    expect(summarize(buildRows([A, FX, B, D, C], acts({ [FX.oid]: 'fixup', [B.oid]: 'squash' }), none))).toEqual({ before: 5, after: 3, dropped: 0 });
  });

  it("detects an unchanged list", () => {
    expect(isUnchanged(ORIGINAL, buildRows(ORIGINAL, acts(), none))).toBe(true);
    expect(isUnchanged(ORIGINAL, buildRows([B, A, C, FX, D], acts(), none))).toBe(false);
    expect(isUnchanged(ORIGINAL, buildRows(ORIGINAL, acts({ [A.oid]: 'reword' }), none))).toBe(false);
  });
});
