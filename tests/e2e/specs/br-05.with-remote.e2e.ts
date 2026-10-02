// BR-05 — Ahead / behind (, 06). Fixture `with-remote`.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git } from '../../support/git-state';
import { appReady, byTid, until } from '../../support/ui';

const itemText = (ref: string) => byTid('sidebar-branch-item', { ref }).getText();

describe('BR-05 — Branches : ahead / behind', () => {
  it("BR-05 — hand displays ▼2 then ↑1 ▼2 after a local commit; feature (without upstream) does not display a counter", async () => {
    const { repo } = currentSession();
    await appReady();

    // hand follows origin/hand, which has 2 commits ahead.
    expect(git(repo, 'rev-list', '--count', 'main..origin/main')).toBe('2');
    await until(async () => (await itemText('refs/heads/main')).includes('↓2'), { message: "hand should display ▼2" });
    expect(await itemText('refs/heads/main')).not.toContain('↑');
    const feature = await itemText('refs/heads/feature');
    expect(feature).not.toContain('↑');
    expect(feature).not.toContain('↓');

    // A local commit in terminal: after repo:changed, ↑1 ▼2.
    git(repo, 'commit', '--allow-empty', '-m', "local: commit out of gitmini");
    await until(async () => {
      const text = await itemText('refs/heads/main');
      return text.includes('↑1') && text.includes('↓2');
    }, { message: "hand should display ↑1 ▼2" });
  });
});
