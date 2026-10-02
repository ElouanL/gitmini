// `git` ASYNCHRONE. Test/support helpers (`git`, `fx.git`) are synchronous (spawnSync): they block the loop
// The GitHub mock of a scenario turns in this worker: a `git fetch|clone|push` synchronizes to
// the URL of the mock could never be served (interlocking). Any git command that speaks to the mock starts with
// `gitAsync`. (The application is another process: no risk on this side.)

import { spawn } from 'node:child_process';
import { type Env, envFor, gitBinary } from '../../support/fixture';

export interface GitAsyncResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function gitAsync(cwd: string, args: readonly string[], opts: { env?: Env; extraEnv?: Env; input?: string } = {}): Promise<GitAsyncResult> {
  return new Promise((resolveGit, reject) => {
    const child = spawn(gitBinary(), ['-C', cwd, ...args], {
      env: { ...(opts.env ?? envFor(cwd)), ...opts.extraEnv, GIT_EDITOR: 'true' },
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.once('error', reject);
    child.once('close', (status) => resolveGit({ status, stdout, stderr }));
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}
