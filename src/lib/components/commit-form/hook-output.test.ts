import { describe, expect, it } from 'vitest';
import { hookOutputFor } from './hook-output';

describe('hookOutputFor', () => {
  const err = (details?: Record<string, unknown>) => ({ code: 'GIT_FAILED' as const, message: "git failed", ...(details ? { details } : {}) });

  it("commit_create and merge_continue : hook stderr", () => {
    expect(hookOutputFor(err({ stderr: 'lint ko\n' }), 'commit_create')).toEqual({ stderr: 'lint ko', command: 'commit_create' });
    expect(hookOutputFor(err({ stderr: "refused" }), 'merge_continue')).toEqual({ stderr: "refused", command: 'merge_continue' });
  });

  it("without stderr: the error message", () => {
    expect(hookOutputFor(err({ stderr: '  ' }), 'commit_create')?.stderr).toBe("git failed");
    expect(hookOutputFor(err(), 'commit_create')?.stderr).toBe("git failed");
  });

  it("another command or code: no processing (toast of the base)", () => {
    expect(hookOutputFor(err({ stderr: 'x' }), 'stage_paths')).toBeNull();
    expect(hookOutputFor(err({ stderr: 'x' }), undefined)).toBeNull();
    expect(hookOutputFor({ code: 'BUSY', message: 'x' }, 'commit_create')).toBeNull();
  });
});
