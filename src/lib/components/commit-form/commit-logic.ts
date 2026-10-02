// Pure logic of the commit form (05 "commit Form", "Commit", "Amend"): button activation,
// meter, message cut, warning "already pushed". Tested.
import type { RepoOpState, StatusSnapshot } from '$lib/ipc/types';

export type FormMode = 'commit' | 'amend' | 'merge';

/** Grey ≤ 50, orange 51–72, red > 72: warning only, never blocking. */
export const SUMMARY_WARN_AT = 50;
export const SUMMARY_DANGER_AT = 72;

export type CounterLevel = 'ok' | 'warn' | 'danger';

export function summaryLength(summary: string): number {
  return Array.from(summary).length;
}

export function counterLevel(length: number): CounterLevel {
  if (length > SUMMARY_DANGER_AT) return 'danger';
  if (length > SUMMARY_WARN_AT) return 'warn';
  return 'ok';
}

/** `commit-form` visible ? Masked during rebase, cherry-pick, revert and am : the continuation passes through `op-banner` (05). */
export function formVisible(op: Pick<RepoOpState, 'kind'> | null): boolean {
  return op === null || op.kind === 'merge';
}

export function formMode(op: Pick<RepoOpState, 'kind'> | null, amend: boolean): FormMode {
  if (op?.kind === 'merge') return 'merge';
  return amend ? 'amend' : 'commit';
}

export interface SubmitInputs {
  mode: FormMode;
  summary: string;
  /** Files with a staged change (excluding conflicts). */
  stagedCount: number;
  /** Chemins encore en conflit (merge). */
  conflictCount: number;
  /** A handwriting is in flight. */
  busy: boolean;
}

/**
 * Non-empty summary (after trim) AND (at least one change staged OR amend checked OR merges without remaining conflict) (05 "Commit").
 * So the front never offers empty commit.
 */
export function canSubmit(i: SubmitInputs): boolean {
  if (i.busy) return false;
  if (i.summary.trim() === '') return false;
  switch (i.mode) {
    case 'amend':
      return true;
    case 'merge':
      return i.conflictCount === 0;
    default:
      return i.stagedCount > 0;
  }
}

/** Why the button is disabled (infobull), `null` if it is active. */
export function disabledReason(i: SubmitInputs): 'busy' | 'summary' | 'conflicts' | 'nothing-staged' | null {
  if (i.busy) return 'busy';
  if (i.mode === 'merge' && i.conflictCount > 0) return 'conflicts';
  if (i.summary.trim() === '') return 'summary';
  if (i.mode === 'commit' && i.stagedCount === 0) return 'nothing-staged';
  return null;
}

/** Message Body: `summary + "\n\n" + body`, body omitted if empty (05 "Commit"). */
export function buildMessage(summary: string, body: string): { summary: string; body?: string } {
  const s = summary.trim();
  const b = body.trim();
  return b === '' ? { summary: s } : { summary: s, body: b };
}

/** Full message (merge): `summary\n\nbody`. */
export function joinMessage(summary: string, body: string): string {
  const m = buildMessage(summary, body);
  return m.body ? `${m.summary}\n\n${m.body}` : m.summary;
}

/** Cuts the message from a commit: 1st row = summary, the rest (after the empty line) = description. */
export function splitMessage(message: string): { summary: string; body: string } {
  const text = message.replace(/\r\n/g, '\n');
  const nl = text.indexOf('\n');
  if (nl < 0) return { summary: text.trim(), body: '' };
  return { summary: text.slice(0, nl).trim(), body: text.slice(nl + 1).replace(/^\n+/, '').replace(/\s+$/, '') };
}

/**
 * HEAD is "already pushed" if the upstream exists and `ahead` is 0 (or not yet known) (05 "Amend").
 * Avertissement non bloquant.
 */
export function headIsPushed(s: Pick<StatusSnapshot, 'upstream' | 'ahead'> | null): boolean {
  if (!s || s.upstream === null || s.upstream === undefined) return false;
  return s.ahead === null || s.ahead === undefined || s.ahead === 0;
}

const OID_RE = /^[0-9a-f]{40}$/;

/** Proposed summary for an ongoing merge: `Merge branch '<incoming>'` (05). An incoming oid gives `Merge commit '<oid>'`. */
export function mergeSummary(incoming: string | null | undefined): string {
  const name = (incoming ?? '').replace(/^refs\/heads\//, '').trim();
  if (name === '') return 'Merge';
  return OID_RE.test(name) ? `Merge commit '${name}'` : `Merge branch '${name}'`;
}

export function stagedCount(files: readonly { staged: unknown; conflict?: unknown }[]): number {
  let n = 0;
  for (const f of files) if (f.staged !== null && f.staged !== undefined && (f.conflict === null || f.conflict === undefined)) n++;
  return n;
}
