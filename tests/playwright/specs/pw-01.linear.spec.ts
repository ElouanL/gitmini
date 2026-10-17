// PW-01 — Harness smoke: what every Playwright spec relies on. Fixture `linear` (10 commits, tag v1.0, clean worktree).
// Not a product scenario: it proves isolation, the app/bridge life cycle and the git helpers. Keep it fast.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixturesDir } from '../../support/fixture';
import { expect, test } from '../support';

test.use({ scenario: { fixture: 'linear' } });

test.describe('PW-01 — Playwright harness smoke', () => {
  test('PW-01 — the application opens the isolated repository and renders its graph', async ({ app, repo }) => {
    // the repository is a private copy under this run's temporary folder (the marker check-ghosts looks for), not target/fixtures
    expect(repo.path.startsWith(tmpdir())).toBe(true);
    expect(repo.path).toContain('gitmini-e2e-');
    expect(repo.path).not.toContain('target/fixtures');
    await expect(app.byTid('graph-canvas')).toBeVisible();

    // git helpers read the repository with the same deterministic environment as the bridge
    expect(repo.currentBranch()).toBe('main');
    expect(repo.git('rev-list', '--count', 'HEAD')).toBe('10');
    expect(repo.git('log', '-1', '--format=%an <%ae>')).toBe('Fixture Bot <bot@fixtures.gitmini>');
    expect(repo.refs()).toHaveProperty(['refs/tags/v1.0']);
    expect(repo.gitOk('rev-parse', '--verify', '-q', 'no-such-ref').status).not.toBe(0);

    // the application's configuration lives in this test's HOME, never in the developer's
    expect(app.settingsPath.startsWith(repo.home)).toBe(true);
    await expect.poll(() => JSON.stringify(app.readSettings()), { message: 'opening a repository should record it in settings.json' }).toContain(repo.path);
    expect(app.pageErrors).toEqual([]);
  });

  test('PW-01 — a change made with git from the outside shows up in the application', async ({ app, repo }) => {
    repo.git('branch', 'smoke-branch', 'main~1');
    await expect(app.byTid('sidebar-branch-item', { ref: 'refs/heads/smoke-branch' })).toBeVisible();
  });

  test('PW-01 — the fixture itself is never modified: committing in the test copy leaves target/fixtures untouched', async ({ repo }) => {
    const pristine = join(fixturesDir(), 'linear', 'repo');
    expect(repo.gitIn(pristine, 'rev-list', '--count', 'HEAD')).toBe('10');
    repo.git('commit', '--allow-empty', '-q', '-m', 'only in this test');
    expect(repo.git('rev-list', '--count', 'HEAD')).toBe('11');
    expect(repo.gitIn(pristine, 'rev-list', '--count', 'HEAD')).toBe('10');
  });

  test('PW-01 — restart brings the same repository back, with or without a path argument (the workspace tabs restore it)', async ({ app, repo }) => {
    repo.git('branch', 'kept-across-restart');
    await app.restart();
    await expect(app.byTid('graph-canvas')).toBeVisible();
    await expect(app.byTid('sidebar-branch-item', { ref: 'refs/heads/kept-across-restart' })).toBeVisible();

    // relaunched like `gitmini` without a path: settings.json (same HOME) still lists the open tab, so the app reopens it
    await app.restart({ args: [] });
    await expect(app.byTid('graph-canvas')).toBeVisible();
    expect(JSON.stringify(app.readSettings()['workspace.tabs'])).toContain(repo.path);
  });
});
