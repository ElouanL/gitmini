// Common ST / RM / GH / UNDO / SAFE specs aids (B-flow agent): mock GitHub, IU connection, subprocess git log.
// This file is not a spec (no `.e2e.ts` suffix): WDIO and check-traceability ignore it.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PreparedFixture } from '../../support/fixture';
import { type GithubMock, startMock } from '../../support/github-mock/index.mjs';
import { click, idle, typeInto, waitForGone, waitForTestId } from '../../support/ui';
import { currentSession } from '../helpers';

/**
 * Start the GitHub mock and publish, like repositories `<owner>/<repo>.git` smart HTTP clones bare `repos`
 * (`{ 'octo-test/alpha': <source repository path> }`). `tokenSequence`: Scripted Device Flow responses:
 * pending, pending, success).
 */
export async function startGithubMock(
  fx: PreparedFixture,
  repos: Record<string, string> = {},
  opts: { tokenSequence?: Parameters<GithubMock['config']>[0]['tokenSequence'] } = {},
): Promise<GithubMock> {
  const mock = await startMock();
  for (const [slug, source] of Object.entries(repos)) {
    const bare = mock.bareRepoPath(slug);
    mkdirSync(dirname(bare), { recursive: true });
    fx.gitIn(fx.root, 'clone', '-q', '--bare', source, bare);
  }
  if (opts.tokenSequence) mock.config({ tokenSequence: opts.tokenSequence });
  return mock;
}

/** "Connected" (GH-02, GH-04, GH-05, GH-07, RM-06, RM-08): Device Flow connection through the interface, the mock allowing the first poll. */
export async function loginViaUi(): Promise<void> {
  await click('toolbar-github-btn');
  await click('github-login-btn');
  await waitForTestId('github-account-badge');
  await waitForGone('github-login-dialog');
}

/** Lines of the subprocess git log of the application (`git spawn argv=[…] code=…`), all log sessions combined. */
export function gitSpawnLines(): string[] {
  return readLogLines().filter((l) => l.includes('git spawn'));
}

/** All lines of the log files of the session (bridge, application). */
export function readLogLines(): string[] {
  const { logsDir } = currentSession();
  if (!existsSync(logsDir)) return [];
  return readdirSync(logsDir).flatMap((name) => readFileSync(join(logsDir, name), 'utf8').split('\n'));
}

/** Number of subprocess git whose argv contains `sub` as an element (`"merge"`, `"push"`...). */
export function spawnCount(sub: string): number {
  return gitSpawnLines().filter((l) => l.includes(`"${sub}"`)).length;
}

/** Creates `file`, index and commit PAR The INTERFACE (wt-panel, commit-form): only gitmini operations can be cancelled. */
export async function commitInApp(file: string, message: string): Promise<void> {
  const { repo } = currentSession();
  writeFileSync(join(repo, file), `${message}\n`);
  await click('graph-wip-row');
  await waitForTestId('wt-unstaged-item', { attrs: { path: file } });
  await click('wt-stage-all-btn');
  await idle();
  await typeInto('commit-summary-input', message);
  await click('commit-submit-btn');
  await idle();
}
