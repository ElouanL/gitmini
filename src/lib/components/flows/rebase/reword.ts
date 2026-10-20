// "Edit message…" of one commit of HEAD's first-parent history: an interactive rebase covering `parent..HEAD` where only
// the target is `reword` (with the new message) and every other commit a `pick`. Execution stays with `git rebase` (the
// backend translates the reword into `pick` + `exec git commit --amend --only`: the commit-msg hook runs, pre-commit
// does not). Pure logic.
import { t } from '$i18n/index';
import type { ActionContext } from '$lib/actions/registry';
import { splitMessage } from '$lib/components/commit-form/commit-logic';
import type { TodoItem, TodoPreviewItem } from '$lib/ipc/types';
import { headOnBranch, loadedRowIndex } from '../branches/common';
import type { ParentsRow } from './reachability';

export type RewordReason = 'merge' | 'not-in-head' | 'unknown';

export type RewordCheck =
  | {
      ok: true;
      /** Parent of the target: base of the rebase; `null` = `--root`. */
      upstream: string | null;
      /** Commits above the target up to HEAD, rewritten too. */
      later: number;
    }
  | { ok: false; reason: RewordReason };

/**
 * Can `oid` be reworded? Walks HEAD's first parents in the loaded graph lines only (no IPC): a missing line gives `unknown`,
 * the backend decides. The target and every commit above it up to HEAD must not be merges (unsupported by the rebase).
 */
export function checkRewordTarget(oid: string, rows: ReadonlyMap<string, ParentsRow>, headOid: string | null): RewordCheck {
  if (!headOid) return { ok: false, reason: 'unknown' };
  let cur: string | null = headOid;
  let later = 0;
  while (cur !== null) {
    const row = rows.get(cur);
    if (!row) return { ok: false, reason: 'unknown' };
    if (row.parents.length > 1) return { ok: false, reason: 'merge' };
    if (cur === oid) return { ok: true, upstream: row.parents[0] ?? null, later };
    cur = row.parents[0] ?? null;
    later++;
  }
  return { ok: false, reason: 'not-in-head' };
}

/**
 * A commit message cut for the dialog: the first line as the summary, the rest as the description, and how they were
 * separated. A first paragraph spread over several lines (no blank line after the subject) keeps its single newline,
 * so that editing the description does not split the paragraph git reads as the subject (`%s`).
 */
export function splitRewordMessage(message: string): { summary: string; body: string; separator: string } {
  const { summary, body } = splitMessage(message);
  const text = message.replace(/\r\n/g, '\n');
  const nl = text.indexOf('\n');
  const joined = nl >= 0 && body !== '' && text.charAt(nl + 1) !== '\n' && text.slice(nl + 1).trim() !== '';
  return { summary, body, separator: joined ? '\n' : '\n\n' };
}

/**
 * The message sent for the reworded commit: trimmed summary, then the description after `separator` (a blank line
 * unless the original first paragraph went on without one), omitted if empty. Only blank lines are cut before the
 * description, never the indentation of its first line (a command or a quoted log kept as is):
 * `splitRewordMessage` then `rewordMessage` gives back the original message.
 */
export function rewordMessage(summary: string, body: string, separator = '\n\n'): string {
  const s = summary.trim();
  const b = body.replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
  return b === '' ? s : `${s}${separator}${b}`;
}

/**
 * Todo sent to `rebase_interactive_start`: every commit of the preview as `pick`, the target as `reword` with `message`.
 * `'stale'` if the target is not in the preview (HEAD moved since the analysis).
 */
export function buildRewordTodo(preview: readonly Pick<TodoPreviewItem, 'oid'>[], oid: string, message: string): TodoItem[] | 'stale' {
  if (!preview.some((i) => i.oid === oid)) return 'stale';
  return preview.map((i): TodoItem => (i.oid === oid ? { oid: i.oid, action: 'reword', message } : { oid: i.oid, action: 'pick' }));
}

/** Targeted commit: the one of the `commit` context menu, otherwise the single selected commit of the graph. */
export function rewordTargetOid(ctx: ActionContext): string | null {
  if (ctx.target?.menu === 'commit') return ctx.target.oids.length <= 1 ? ctx.target.oid : null;
  return ctx.graph.singleCommitOid;
}

/**
 * The target can be reworded as far as the loaded lines tell (a line not loaded leaves it to the backend): one commit, HEAD
 * on a branch, commit on HEAD's first-parent history without merge up to HEAD.
 */
export function rewordEligible(ctx: ActionContext): boolean {
  if (ctx.repoId === null || !headOnBranch(ctx.session)) return false;
  const oid = rewordTargetOid(ctx);
  if (oid === null) return false;
  const check = checkRewordTarget(oid, loadedRowIndex(ctx.session), ctx.repo.head?.oid ?? null);
  return check.ok || check.reason === 'unknown';
}

/** Tooltip of the disabled `commit.reword` action when the target is eligible (an operation blocks writes), `null` otherwise. */
export function rewordDisabledReason(ctx: ActionContext): string | null {
  if (ctx.repoId === null) return t('action.noRepo');
  return rewordEligible(ctx) ? ctx.op.blockReason('write') : null;
}
