// `GIT_FAILED` on `commit_create` or `merge_continue`: hook output (stderr) displayed in `commit-hook-output` (05, ).
import type { AppError } from '$lib/ipc/types';

export const HOOK_COMMANDS = ['commit_create', 'merge_continue'] as const;

export function hookOutputFor(err: Pick<AppError, 'code' | 'message' | 'details'>, command: string | undefined): { stderr: string; command: string } | null {
  if (err.code !== 'GIT_FAILED' || !command || !(HOOK_COMMANDS as readonly string[]).includes(command)) return null;
  const stderr = err.details?.stderr;
  const text = typeof stderr === 'string' && stderr.trim() !== '' ? stderr.trim() : err.message;
  return { stderr: text, command };
}
