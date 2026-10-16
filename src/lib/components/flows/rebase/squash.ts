// "Squash N commits" from the graph selection: consecutive commits only, rewritten by an interactive rebase covering
// `upstream..HEAD` (pick for the oldest, squash for the others, pick for the commits above). A consecutive squash S1..Sk
// produces exactly the tree of Sk: the following picks cannot conflict. Selection analysis and todo construction are pure.
import { t } from '$i18n/index';
import type { ActionContext } from '$lib/actions/registry';
import type { TodoItem, TodoPreviewItem } from '$lib/ipc/types';
import { headOnBranch, loadedRowIndex } from '../branches/common';
import { selectedCommitOids } from '../pick/run';
import type { ParentsRow } from './reachability';

export type SquashReason = 'too-few' | 'not-consecutive' | 'merge' | 'not-in-head' | 'unknown';

export type SquashCheck =
  | {
      ok: true;
      /** Selected commits, oldest first (parent chain order, whatever the click order). */
      ordered: string[];
      /** Parent of the oldest commit: base of the rebase; `null` = `--root`. */
      upstream: string | null;
    }
  | { ok: false; reason: SquashReason };

/**
 * Orders `oids` along the first-parent chain (oldest first). `null` if they do not form one unbroken chain.
 * `parentOf` gives the first parent (`null` for a root commit).
 */
export function orderByParents(oids: readonly string[], parentOf: (oid: string) => string | null): string[] | null {
  const set = new Set(oids);
  const parents = new Set<string>();
  for (const o of set) {
    const p = parentOf(o);
    if (p !== null && set.has(p)) parents.add(p);
  }
  // The newest commit is the only one that is not the parent of another selected commit.
  const tops = [...set].filter((o) => !parents.has(o));
  if (tops.length !== 1) return null;
  const chain: string[] = [];
  let cur: string | null = tops[0]!;
  while (cur !== null && set.has(cur)) {
    chain.push(cur);
    cur = parentOf(cur);
  }
  return chain.length === set.size ? chain.reverse() : null;
}

/**
 * Can the selection be squashed? Read in the loaded graph lines only (no IPC): a missing line gives `unknown`, the
 * backend decides. The range from the newest selected commit up to HEAD must not cross a merge (unsupported by the rebase).
 */
export function checkSquashSelection(oids: readonly string[], rows: ReadonlyMap<string, ParentsRow>, headOid: string | null): SquashCheck {
  const unique = [...new Set(oids)];
  if (unique.length < 2) return { ok: false, reason: 'too-few' };
  for (const o of unique) {
    const row = rows.get(o);
    if (!row) return { ok: false, reason: 'unknown' };
    if (row.parents.length > 1) return { ok: false, reason: 'merge' };
  }
  const ordered = orderByParents(unique, (o) => rows.get(o)!.parents[0] ?? null);
  if (!ordered) return { ok: false, reason: 'not-consecutive' };

  if (!headOid) return { ok: false, reason: 'unknown' };
  const newest = ordered[ordered.length - 1]!;
  let cur: string | null = headOid;
  while (cur !== newest) {
    if (cur === null) return { ok: false, reason: 'not-in-head' };
    const row = rows.get(cur);
    if (!row) return { ok: false, reason: 'unknown' };
    if (row.parents.length > 1) return { ok: false, reason: 'merge' };
    cur = row.parents[0] ?? null;
  }
  return { ok: true, ordered, upstream: rows.get(ordered[0]!)!.parents[0] ?? null };
}

/** Default message: subject of the oldest commit as title, then the subjects of the others, one per line (oldest first). */
export function defaultSquashMessage(items: readonly Pick<TodoPreviewItem, 'summary'>[]): string {
  const [first, ...rest] = items;
  if (!first) return '';
  return rest.length > 0 ? `${first.summary}\n\n${rest.map((i) => i.summary).join('\n')}` : first.summary;
}

/**
 * Todo sent to `rebase_interactive_start`: every commit of the preview, `squash` for the selected commits after the oldest,
 * the last one always carrying `message` (unlike `toTodoItems`, which omits a group message left as pre-filled).
 * `'stale'` if the selected commits are not contiguous in the preview (HEAD moved since the analysis).
 */
export function buildSquashTodo(preview: readonly Pick<TodoPreviewItem, 'oid'>[], ordered: readonly string[], message: string): TodoItem[] | 'stale' {
  const start = preview.findIndex((i) => i.oid === ordered[0]);
  if (start < 0 || ordered.length < 2) return 'stale';
  for (let k = 0; k < ordered.length; k++) if (preview[start + k]?.oid !== ordered[k]) return 'stale';
  const last = start + ordered.length - 1;
  return preview.map((i, idx): TodoItem => {
    if (idx <= start || idx > last) return { oid: i.oid, action: 'pick' };
    return idx === last ? { oid: i.oid, action: 'squash', message } : { oid: i.oid, action: 'squash' };
  });
}

/** Targeted commits: those in the `commit` context menu, otherwise the graph selection. */
export function squashTargetOids(ctx: ActionContext): string[] {
  return ctx.target?.menu === 'commit' ? ctx.target.oids : selectedCommitOids();
}

/** Tooltip of the disabled `rebase.squash` action (`multi-commit-squash-btn`), `null` if enabled. */
export function squashDisabledReason(ctx: ActionContext): string | null {
  if (ctx.repoId === null) return t('action.noRepo');
  const blocked = ctx.op.blockReason('write');
  if (blocked) return blocked;
  const oids = squashTargetOids(ctx);
  if (new Set(oids).size < 2) return t('rebase.squash.disabled.too-few');
  if (!headOnBranch(ctx.session)) return t('rebase.squash.disabled.detached');
  const check = checkSquashSelection(oids, loadedRowIndex(ctx.session), ctx.repo.head?.oid ?? null);
  if (!check.ok && check.reason !== 'unknown') return t(`rebase.squash.disabled.${check.reason}`);
  return null;
}
