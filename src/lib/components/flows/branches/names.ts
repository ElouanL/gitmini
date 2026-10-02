// Validation of UI-side branch names (06 "Name Validation"): same rules as `git check-ref-format --branch`
// applied by gix backend side, for immediate return during input. Backend always revalidates
// (`INVALID_ARGUMENT { field: "name", reason }`).
import { t } from '$i18n/index';
import type { AppError } from '$lib/ipc/types';

export type BranchNameReason =
  | 'empty'
  | 'head'
  | 'lone-at'
  | 'leading-dash'
  | 'leading-slash'
  | 'trailing-slash'
  | 'double-slash'
  | 'double-dot'
  | 'control-char'
  | 'forbidden-char'
  | 'at-brace'
  | 'trailing-dot'
  | 'component-dot'
  | 'lock-suffix';

export interface BranchNameProblem {
  reason: BranchNameReason;
  /** Wrong character (`forbidden-char`). */
  char?: string;
}

const FORBIDDEN_CHARS = new Set(['~', '^', ':', '?', '*', '[', '\\', ' ']);

/** Entered spaces (and other blanks) are converted to `-`, while entering. */
export function normalizeBranchInput(raw: string): string {
  return raw.replace(/\s/g, '-');
}

/** `null` if the name is accepted, otherwise the first rule violated. An empty name is `empty` (no message to display). */
export function validateBranchName(name: string): BranchNameProblem | null {
  if (name === '') return { reason: 'empty' };
  if (name === 'HEAD') return { reason: 'head' };
  if (name === '@') return { reason: 'lone-at' };
  if (name.startsWith('-')) return { reason: 'leading-dash' };
  if (name.startsWith('/')) return { reason: 'leading-slash' };
  if (name.endsWith('/')) return { reason: 'trailing-slash' };
  if (name.includes('//')) return { reason: 'double-slash' };
  if (name.includes('..')) return { reason: 'double-dot' };
  for (const ch of name) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return { reason: 'control-char' };
    if (FORBIDDEN_CHARS.has(ch)) return { reason: 'forbidden-char', char: ch };
  }
  if (name.includes('@{')) return { reason: 'at-brace' };
  if (name.endsWith('.')) return { reason: 'trailing-dot' };
  for (const part of name.split('/')) {
    if (part.startsWith('.')) return { reason: 'component-dot' };
    if (part.endsWith('.lock')) return { reason: 'lock-suffix' };
  }
  return null;
}

const KNOWN_REASONS: readonly string[] = [
  'head', 'lone-at', 'leading-dash', 'leading-slash', 'trailing-slash', 'double-slash', 'double-dot', 'control-char',
  'forbidden-char', 'at-brace', 'trailing-dot', 'component-dot', 'lock-suffix',
];

/** Full message "Unable branch name: <reason>." for a local reason. `null` for an empty name. */
export function problemMessage(p: BranchNameProblem): string | null {
  if (p.reason === 'empty') return null;
  return t('branches.name.invalid', { reason: t(`branches.name.reason.${p.reason}`, { char: p.char ?? '' }) });
}

/** Message for `INVALID_ARGUMENT { field: "name", reason }` backend rejection (known or raw reason). */
export function backendReasonMessage(reason: unknown): string {
  if (typeof reason === 'string' && KNOWN_REASONS.includes(reason)) {
    return t('branches.name.invalid', { reason: t(`branches.name.reason.${reason}`, { char: '' }) });
  }
  return t('branches.name.invalid', { reason: typeof reason === 'string' && reason ? reason : '?' });
}

/** Proposed local name for a remote branch that collids (`origin/feature/x` → `origin-feature-x`). */
export function suggestLocalName(remoteRef: string): string {
  return remoteRef.replace(/\//g, '-');
}

/**
 * Message from a `INVALID_ARGUMENT` that targets one of the `fields` in a dialog (backend calls the field of the IPC: `name`, `newName`,
 * `oldName`, `localName`, `startPoint`, `autoStash`...), to display SOUS the field. `null` if the error targets another field: the
 * then leaves it to the general routing (toast). The backend `message` is already in English and can be displayed as is.
 */
export function fieldErrorMessage(e: AppError, fields: readonly string[]): string | null {
  if (e.code !== 'INVALID_ARGUMENT') return null;
  const field = e.details?.field;
  if (typeof field !== 'string' || !fields.includes(field)) return null;
  return e.message || backendReasonMessage(e.details?.reason);
}
