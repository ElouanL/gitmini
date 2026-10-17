// TAG-04 — Pushing a branch with its tags (`--follow-tags`): the push dialog has an "Also push annotated tags" box, off by default;
// checked, the annotated tags the branch carries go up with it, and neither a lightweight tag nor an annotated tag of work the branch does
// not carry does. Fixture `with-remote`, HEAD on `feature` (tag-04.with-remote.setup.ts).
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, revParse, revParseOpt } from '../../support/git-state';
import { appReady, click, idle, textOf, waitForGone, waitForTestId, waitForToastText } from '../../support/ui';

describe('TAG-04 — Push with --follow-tags', () => {
  it('TAG-04 — with the box checked the annotated tags of the branch go up with it, and no other', async () => {
    const { repo, fx } = currentSession();
    await appReady();
    expect(revParseOpt(fx.origin, 'refs/heads/feature')).toBeNull();
    expect(git(fx.origin, 'tag', '-l')).toBe('v1.0');

    await click('toolbar-push-btn');
    await waitForTestId('push-dialog');
    await expect(await waitForTestId('push-follow-tags-toggle')).not.toBeSelected(); // off by default
    expect(await textOf('push-dialog')).toContain('Also push annotated tags (--follow-tags)');
    await click('push-follow-tags-toggle');
    await expect(await waitForTestId('push-follow-tags-toggle')).toBeSelected();
    await click('push-submit-btn');
    await waitForGone('push-dialog');
    await idle();
    await waitForToastText('success', 'Push finished');

    expect(fx.gitIn(fx.origin, 'rev-parse', 'refs/heads/feature')).toBe(revParse(repo, 'refs/heads/feature'));
    // The annotated tag went up as a tag object, not as a bare commit.
    expect(fx.gitIn(fx.origin, 'rev-parse', 'refs/tags/rel-1.0')).toBe(revParse(repo, 'refs/tags/rel-1.0'));
    expect(fx.gitIn(fx.origin, 'cat-file', '-t', 'refs/tags/rel-1.0')).toBe('tag');
    // A lightweight tag never follows, and an annotated tag whose commit is not on the branch (nor on the remote) stays home.
    expect(revParseOpt(fx.origin, 'refs/tags/light-1')).toBeNull();
    expect(revParseOpt(fx.origin, 'refs/tags/elsewhere')).toBeNull();
    expect(git(fx.origin, 'tag', '-l').split('\n')).toEqual(['rel-1.0', 'v1.0']);
  });
});
