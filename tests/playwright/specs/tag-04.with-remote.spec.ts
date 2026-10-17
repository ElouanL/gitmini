// TAG-04 — Pushing a branch with its tags (`--follow-tags`): the push dialog has an "Also push annotated tags" box, off by default.
// Without it the branch goes up alone; with it the annotated tags the branch carries go up with it, and neither a lightweight tag nor
// an annotated tag of work the branch does not carry does. Port of tests/e2e/specs/tag-04.with-remote.e2e.ts (WebdriverIO) to the Playwright
// harness, plus the box left alone and the tags that must stay home. Fixture `with-remote`, HEAD on `feature` (tag-04.with-remote.setup.ts).
import { expect, refs, revParse, revParseOpt, test, type App, type Repo } from '../support';
import { toastSaying } from '../helpers/tagtrash-ui';
import { setup } from './tag-04.with-remote.setup';

test.use({ scenario: { fixture: 'with-remote', setup } });

/** The tags `origin` holds, by full ref name. */
const originTags = (repo: Repo): string[] =>
  Object.keys(refs(repo.origin))
    .filter((name) => name.startsWith('refs/tags/'))
    .sort();

/** Toolbar Push on the unpublished branch: the dialog opens with the box unchecked. */
async function openPushDialog(app: App): Promise<void> {
  await app.click('toolbar-push-btn');
  await app.waitFor('push-dialog');
  await expect(app.byTid('push-follow-tags-toggle')).not.toBeChecked();
}

/** Submit the dialog and wait for the push to finish. */
async function submit(app: App): Promise<void> {
  await app.click('push-submit-btn');
  await app.waitGone('push-dialog');
  await app.idle();
  await expect(toastSaying(app, 'success', 'Push finished')).toBeVisible();
}

test.describe('TAG-04 — Push with --follow-tags', () => {
  test('TAG-04 — the box is off by default and the branch goes up alone, tags stay home', async ({ app, repo }) => {
    expect(revParseOpt(repo.origin, 'refs/heads/feature')).toBeNull();
    expect(originTags(repo)).toEqual(['refs/tags/v1.0']);
    const localRefs = repo.refs();

    await openPushDialog(app);
    await expect(app.byTid('push-follow-tags-toggle')).toBeVisible();
    await expect(app.byTid('push-dialog')).toContainText('Also push annotated tags (--follow-tags)');
    await submit(app);

    expect(repo.gitIn(repo.origin, 'rev-parse', 'refs/heads/feature')).toBe(revParse(repo.path, 'refs/heads/feature'));
    expect(originTags(repo)).toEqual(['refs/tags/v1.0']); // not even the annotated tag of the pushed tip
    expect(repo.refs()).toEqual({ ...localRefs, 'refs/remotes/origin/feature': revParse(repo.path, 'refs/heads/feature') });
  });

  test('TAG-04 — with the box checked the annotated tags of the branch go up with it, and no other', async ({ app, repo }) => {
    await openPushDialog(app);
    await app.byTid('push-follow-tags-toggle').check();
    await expect(app.byTid('push-follow-tags-toggle')).toBeChecked();
    await submit(app);

    expect(repo.gitIn(repo.origin, 'rev-parse', 'refs/heads/feature')).toBe(revParse(repo.path, 'refs/heads/feature'));
    // The annotated tag went up as a tag object, not as a bare commit.
    expect(repo.gitIn(repo.origin, 'rev-parse', 'refs/tags/rel-1.0')).toBe(revParse(repo.path, 'refs/tags/rel-1.0'));
    expect(repo.gitIn(repo.origin, 'cat-file', '-t', 'refs/tags/rel-1.0')).toBe('tag');
    // A lightweight tag never follows, and an annotated tag whose commit is not on the branch (nor on the remote) stays home.
    expect(revParseOpt(repo.origin, 'refs/tags/light-1')).toBeNull();
    expect(revParseOpt(repo.origin, 'refs/tags/elsewhere')).toBeNull();
    expect(originTags(repo)).toEqual(['refs/tags/rel-1.0', 'refs/tags/v1.0']);
    // Nothing local moved because of it.
    expect(revParseOpt(repo.path, 'refs/tags/light-1')).not.toBeNull();
    expect(revParseOpt(repo.path, 'refs/tags/elsewhere')).not.toBeNull();
  });
});
