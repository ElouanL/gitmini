// Self-test harness (ST-05): sentinel hook in context WDIO, without fixed waiting: git is blocked in
// `pre-commit` until the spec releases the sentinel; real git state before and after (double assertion).
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { expect } from '@wdio/globals';
import { git, gitState, head } from '../../../support/git-state';
import { installHook, release, waitReached } from '../../../support/sentinel';
import { currentSession } from '../../helpers';
import { appReady, until } from '../../../support/ui';

describe('ST-05 — hook sentinelle', () => {
  it("ST-05 — git remains stuck in the hook until sentinel release", async () => {
    const session = currentSession();
    await appReady();
    const before = gitState(session.repo);
    const sentinel = installHook(session.repo, 'pre-commit', join(session.tmp, 'sentinels', 'pre-commit'));

    const child = spawn('git', ['-C', session.repo, 'commit', '--allow-empty', '-m', "in the hook"], { env: session.env, stdio: 'ignore' });
    const exited = new Promise<number | null>((resolve) => child.once('close', resolve));
    try {
      await waitReached(sentinel); // git is in the hook: the "command" is in flight
      expect(head(session.repo)).toBe(before.head); // nothing is committed yet
      expect(git(session.repo, 'log', '-1', '--format=%s')).not.toBe("in the hook");
    } finally {
      release(sentinel);
    }
    expect(await exited).toBe(0);
    await until(() => head(session.repo) !== before.head);
    expect(git(session.repo, 'log', '-1', '--format=%s')).toBe("in the hook");
  });
});
