// PUR interactive rebase model (07 "Interactive Rebase", ): lines derived from the chosen order and actions, groups
// squash/fixup, message fields, validation (same rules as backend), translation to `TodoItem[]`, summary.
// No Svelte or IPC dependencies: testable alone.
import type { TodoAction, TodoItem, TodoPreviewItem } from '$lib/ipc/types';

export type TodoProblem = 'all-dropped' | 'first-is-squash' | 'empty-message';

export const TODO_ACTIONS: readonly TodoAction[] = ['pick', 'reword', 'squash', 'fixup', 'drop'];

/** Message field displayed on a line. */
export interface MessageField {
  /** `reword`: message from the line; `group`: final message from the squash/fixup group (carried by its last member). */
  kind: 'reword' | 'group';
  /** Current value: input, if not initial value. */
  value: string;
  /** Pre-filled (original message, or concatenation of pick and squash). */
  initial: string;
  /** Different pre-fill input: message sent to backend. */
  edited: boolean;
}

export interface TodoRow {
  item: TodoPreviewItem;
  action: TodoAction;
  /** The head (pick/reword) of the group that this squash/fixup line joins; `null` otherwise. */
  joins: string | null;
  /** Number of attached squash/fixup lines (heads only). */
  members: number;
  /** Last squash/fixup line of a group: it carries the final message. */
  lastOfGroup: boolean;
  field: MessageField | null;
}

export interface TodoEdits {
  /** Messages entered `reword` lines, by oid. */
  reword: Readonly<Record<string, string>>;
  /** Messages received from groups, by oid of the group's HEAD. */
  group: Readonly<Record<string, string>>;
}

const trimEnd = (s: string): string => s.replace(/\s+$/, '');

/**
 * Lines displayed, in the current order. A line `squash`/`fixup` joins the last line `pick`/`reword` that precedes it
 * (`drop` lines intersected are ignored, as in the git todo).
 */
export function buildRows(order: readonly TodoPreviewItem[], actions: Readonly<Record<string, TodoAction>>, edits: TodoEdits): TodoRow[] {
  const rows: TodoRow[] = order.map((item) => ({
    item,
    action: actions[item.oid] ?? 'pick',
    joins: null,
    members: 0,
    lastOfGroup: false,
    field: null,
  }));

  const groups = new Map<TodoRow, TodoRow[]>();
  let head: TodoRow | null = null;
  for (const row of rows) {
    if (row.action === 'drop') continue;
    if (row.action === 'squash' || row.action === 'fixup') {
      if (head) {
        row.joins = head.item.oid;
        groups.get(head)!.push(row);
      }
      continue;
    }
    head = row;
    groups.set(row, []);
  }

  for (const [h, members] of groups) {
    h.members = members.length;
    if (members.length === 0) {
      if (h.action === 'reword') {
        const initial = trimEnd(h.item.message);
        const value = edits.reword[h.item.oid] ?? initial;
        h.field = { kind: 'reword', initial, value, edited: value !== initial };
      }
      continue;
    }
    const last = members[members.length - 1]!;
    last.lastOfGroup = true;
    const initial = [h, ...members.filter((m) => m.action === 'squash')].map((r) => trimEnd(r.item.message)).join('\n\n');
    const value = edits.group[h.item.oid] ?? initial;
    last.field = { kind: 'group', initial, value, edited: value !== initial };
  }
  return rows;
}

/** First rule violated (same order as the backend), `null` if the list is valid. */
export function validateTodo(rows: readonly TodoRow[]): TodoProblem | null {
  const kept = rows.filter((r) => r.action !== 'drop');
  if (kept.length === 0) return 'all-dropped';
  const first = kept[0]!;
  if (first.action === 'squash' || first.action === 'fixup') return 'first-is-squash';
  for (const r of rows) {
    if (r.field && r.field.value.trim() === '') return 'empty-message';
  }
  return null;
}

/**
 * `TodoItem[]` sent to `rebase_interactive_start`. A `reword` head that receives squash/fixup is sent to `pick`: the message
 * final group (carried by its last member) premium. A group message left as pre-filled is not sent
 * (git combines itself).
 */
export function toTodoItems(rows: readonly TodoRow[]): TodoItem[] {
  return rows.map((r): TodoItem => {
    const oid = r.item.oid;
    switch (r.action) {
      case 'drop':
        return { oid, action: 'drop' };
      case 'pick':
        return { oid, action: 'pick' };
      case 'reword':
        if (r.members > 0 || !r.field) return { oid, action: 'pick' };
        return { oid, action: 'reword', message: r.field.value };
      case 'squash':
      case 'fixup':
        return r.lastOfGroup && r.field?.edited ? { oid, action: r.action, message: r.field.value } : { oid, action: r.action };
    }
  });
}

export interface TodoSummary {
  before: number;
  /** Commits obtained: lines `pick` / `reword` (squash/fixup disappears in their group). */
  after: number;
  dropped: number;
}

export function summarize(rows: readonly TodoRow[]): TodoSummary {
  return {
    before: rows.length,
    after: rows.filter((r) => r.action === 'pick' || r.action === 'reword').length,
    dropped: rows.filter((r) => r.action === 'drop').length,
  };
}

/** `true` if the list is identical to the original (same order, all `pick`, no message entered): nothing will change. */
export function isUnchanged(original: readonly TodoPreviewItem[], rows: readonly TodoRow[]): boolean {
  if (original.length !== rows.length) return false;
  return rows.every((r, i) => r.item.oid === original[i]!.oid && r.action === 'pick');
}
