// Parent principal (`-m`) d'un cherry-pick ou revert (09 « Dialogue parent principal ») : logique pure.
import { t } from '$i18n/index';
import { shortOid } from '$lib/format';
import type { GraphRow } from '$lib/ipc/types';

export type PickKind = 'cherry-pick' | 'revert';

export interface MergeInfo {
  oid: string;
  summary: string | null;
  /** Parents of the commit of merge (wild), parent 1 first. */
  parents: string[];
}

/** Result of the analysis of a selection: the merge commits and the number of single commits. */
export interface SelectionAnalysis {
  merges: MergeInfo[];
  simple: number;
}

export interface MainlineChoices {
  /** Proposed values: `1…max`. */
  max: number;
  /** Mix of single merges and commits: only parent 1 is possible (gives away `-m 2` on a single commit). */
  forced: boolean;
}

/**
 * `mainline-select` options: a blend of `p` parents → `1…p`; several merges → `1…min(p)`; mixture of merges and commits
 * simple → `1` only, with one mention.
 */
export function mainlineChoices(merges: readonly Pick<MergeInfo, 'parents'>[], simple: number): MainlineChoices {
  if (merges.length === 0) return { max: 1, forced: false };
  if (simple > 0) return { max: 1, forced: true };
  const max = Math.min(...merges.map((m) => m.parents.length));
  return { max: Math.max(1, max), forced: false };
}

/** Separates a selection of single commits (≥ 2 parents) and commits, based on the number of parents of each oid. */
export function analyzeParents(entries: readonly { oid: string; summary: string | null; parents: string[] }[]): SelectionAnalysis {
  const merges: MergeInfo[] = [];
  let simple = 0;
  for (const e of entries) {
    if (e.parents.length > 1) merges.push({ oid: e.oid, summary: e.summary, parents: e.parents });
    else simple++;
  }
  return { merges, simple };
}

/** `Parent 1 — abc1234 « sujet » (main)`; SHA runs alone (or `Parent n`) when the parent's line is not loaded. */
export function parentLabel(n: number, parentOid: string | undefined, rows: ReadonlyMap<string, GraphRow>): string {
  if (!parentOid) return t('pick.mainline.option.generic', { n });
  const row = rows.get(parentOid);
  const sha = shortOid(parentOid);
  const names = row ? row.refs.filter((r) => r.kind === "local" || r.kind === 'head').map((r) => r.name) : [];
  const refs = names.length > 0 ? ` (${names.join(', ')})` : '';
  if (!row) return t('pick.mainline.option.noSummary', { n, sha, refs });
  return t('pick.mainline.option', { n, sha, summary: row.summary, refs });
}
