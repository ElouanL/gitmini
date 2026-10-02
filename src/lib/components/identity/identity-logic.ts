// Validation of the ID dialog (05 "Identity") and reading of an error of `config_set_identity`. Pure functions, tested.
import type { AppError } from '$lib/ipc/types';

export type IdentityScope = "global" | "local";

export interface IdentityValidation {
  ok: boolean;
  name: 'name' | null;
  email: 'email' | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

/** Name not empty, e-mail with an arobase: git does not ask for more, the rest is the user's business. */
export function validateIdentity(name: string, email: string): IdentityValidation {
  const n = name.trim() === '' ? 'name' : null;
  const e = EMAIL_RE.test(email.trim()) ? null : 'email';
  return { ok: n === null && e === null, name: n, email: e };
}

/** Field targeted by `INVALID_ARGUMENT { field }` error of backend, `null` otherwise. */
export function identityFieldError(err: AppError): 'name' | 'email' | null {
  if (err.code !== 'INVALID_ARGUMENT') return null;
  const field = err.details?.field;
  return field === 'name' || field === 'email' ? field : null;
}
