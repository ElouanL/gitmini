// RSV-06 — Outside a merge, a rebase, a cherry-pick or a stash apply, there is nothing to resolve: the backend refuses `resolve_paths`
// and leaves the repository alone. Fixture `linear`, clean. The interface offers no entry there (no conflict list), so the command is
// sent to the running bridge as the front end would. Extra coverage of the RSV-01 feature ("refused outside a merge or a rebase").
import { expect, test } from '../support';
import { readDiscardJournal, spawnCount } from '../helpers/rsv-af-support';

test.use({ scenario: { fixture: 'linear' } });

test.describe('RSV-06 — Nothing to resolve', () => {
  test('RSV-06 — resolve_paths is refused when the repository is not in conflict, whatever the side, and changes nothing', async ({ app, repo }) => {
    const repoId = Number(await app.attr('repo-tab', 'data-repo-id'));
    expect(await app.isShown('wt-conflict-list')).toBe(false);
    const before = { head: repo.head(), refs: repo.refs(), state: repo.state() };
    const call = async (paths: string[], side: string) => {
      const res = await app.page.request.post(`${app.url}/__gitmini/invoke/resolve_paths`, { data: { repoId, paths, side } });
      return { ok: res.ok(), body: (await res.json()) as { code?: string; details?: { reason?: string; paths?: string[] } } };
    };

    for (const side of ['ours', 'theirs']) {
      const res = await call(['file-1.txt', 'file-2.txt'], side);
      expect(res.ok, side).toBe(false);
      expect(res.body.code, side).toBe('INVALID_ARGUMENT');
      expect(res.body.details, side).toMatchObject({ reason: 'not-conflicted', paths: ['file-1.txt', 'file-2.txt'] });
    }
    // a path that does not exist is not in conflict either; a side that does not exist is not a side
    expect((await call(['nope.txt'], 'ours')).body.details?.reason).toBe('not-conflicted');
    expect((await call(['file-1.txt'], 'base')).ok).toBe(false);

    expect({ head: repo.head(), refs: repo.refs(), state: repo.state() }).toEqual(before);
    expect(repo.git('status', '--porcelain')).toBe('');
    expect(readDiscardJournal(repo)).toEqual([]);
    expect(spawnCount(repo, 'checkout', '--ours') + spawnCount(repo, 'checkout', '--theirs') + spawnCount(repo, 'rm', '-q')).toBe(0);
    // an empty selection is a no-op, not an error
    expect((await call([], 'ours')).ok).toBe(true);
    expect(repo.git('status', '--porcelain')).toBe('');
  });
});
