// TAG-03 — Tags, the cases the journeys of TAG-01 and TAG-02 do not reach (new for the Playwright suite; no WebdriverIO counterpart):
// a repository without remote offers no push, the name rules of the creation dialog, the message that makes a tag annotated (kept
// verbatim), the "New tag..." command on the selected commit, no commit to tag in an empty repository, and creating a tag while a
// merge is stopped. Fixture `linear` + a tag `rel/1` (tag-03.linear.setup.ts); the last two describes use other fixtures.
import { expect, gitOk, gitRaw, inProgress, revParse, revParseOpt, statusPorcelainV2, test } from '../support';
import { clickCommitRow, toastSaying } from '../helpers/tagtrash-ui';
import { setup } from './tag-03.linear.setup';

test.use({ scenario: { fixture: 'linear', setup } });

const tagItem = (name: string) => ({ ref: `refs/tags/${name}` });

test.describe('TAG-03 — Tags without remote, name rules, palette', () => {
  test('TAG-03 — a repository without remote offers neither push nor deletion on a remote, only the local deletion', async ({ app, repo }) => {
    const before = repo.refs();
    await app.rightClick('sidebar-tag-item', tagItem('v1.0'));
    const actions = await app.contextMenuActions();
    expect(actions).toContain('delete');
    expect(actions).not.toContain('push');
    expect(actions).not.toContain('delete-remote');
    await app.press('Escape');
    await app.waitGone('context-menu');
    await app.idle();
    expect(repo.refs()).toEqual(before); // looking at the menu changed nothing
  });

  test('TAG-03 — the name rules: spaces become dashes, a bad name and a hierarchy clash are explained and cannot be submitted', async ({ app, repo }) => {
    const before = repo.refs();
    await app.click('sidebar-tag-create-btn');
    await app.waitFor('tag-create-dialog');
    const submit = app.byTid('tag-create-submit-btn');
    const error = app.byTid('tag-create-error');

    await app.type('tag-create-name-input', 'a..b');
    await expect(error).toHaveText('Invalid tag name: cannot contain "..".');
    await expect(submit).toBeDisabled();
    await app.type('tag-create-name-input', 'bad~name');
    await expect(error).toHaveText('Invalid tag name: "~" is prohibited.');
    await expect(submit).toBeDisabled();
    await app.type('tag-create-name-input', 'v1.0/rc'); // v1.0 is a tag: it cannot also be a folder
    await expect(error).toHaveText('The "v1.0" tag already exists and blocks "v1.0/rc".');
    await expect(submit).toBeDisabled();
    await app.type('tag-create-name-input', 'rel'); // and rel/1 forbids a tag named rel
    await expect(error).toHaveText('The "rel/1" tag already exists and blocks "rel".');
    await expect(submit).toBeDisabled();
    await app.press('Enter'); // Enter cannot submit a name that is refused
    await app.idle();
    await app.waitFor('tag-create-dialog');
    expect(repo.refs()).toEqual(before);

    // Spaces typed become dashes, and a valid name turns the submit button on.
    await app.type('tag-create-name-input', 'my release');
    await expect(app.byTid('tag-create-name-input')).toHaveValue('my-release');
    await expect(error).toHaveCount(0);
    await expect(submit).toBeEnabled();

    // A message made of blanks does not make the tag annotated.
    await app.type('tag-create-message-input', '   \n  ');
    await app.waitFor('tag-create-dialog', { annotated: false });
    await app.click('tag-create-submit-btn');
    await app.idle();
    await app.waitGone('tag-create-dialog');
    expect(repo.git('cat-file', '-t', 'refs/tags/my-release')).toBe('commit');
    expect(revParse(repo.path, 'refs/tags/my-release')).toBe(repo.head());
    expect(repo.refs()).toEqual({ ...before, 'refs/tags/my-release': repo.head() });
  });

  test('TAG-03 — Cancel and Escape create nothing', async ({ app, repo }) => {
    const before = repo.refs();
    await app.click('sidebar-tag-create-btn');
    await app.type('tag-create-name-input', 'never');
    await app.click('tag-create-cancel-btn');
    await app.waitGone('tag-create-dialog');
    await app.idle();
    await app.click('sidebar-tag-create-btn');
    await app.type('tag-create-name-input', 'never');
    await app.press('Escape');
    await app.waitGone('tag-create-dialog');
    await app.idle();
    expect(repo.refs()).toEqual(before);
    expect(revParseOpt(repo.path, 'refs/tags/never')).toBeNull();
    await expect(app.byTid('toast')).toHaveCount(0);
  });

  test('TAG-03 — the message of an annotated tag is kept verbatim: lines starting with "#" and blank lines stay', async ({ app, repo }) => {
    const target = revParse(repo.path, 'HEAD~3');
    await clickCommitRow(app, target, { button: 'right' });
    await app.chooseContextItem('create-tag');
    await app.waitFor('tag-create-dialog');
    await app.type('tag-create-name-input', 'notes');
    await app.type('tag-create-message-input', 'Release notes\n\n# not a comment\n- one\n- two');
    await app.waitFor('tag-create-dialog', { annotated: true });
    await app.click('tag-create-submit-btn');
    await app.idle();
    await app.waitGone('tag-create-dialog');
    expect(repo.git('cat-file', '-t', 'refs/tags/notes')).toBe('tag');
    expect(revParse(repo.path, 'notes^{commit}')).toBe(target);
    expect(gitRaw(repo.path, 'tag', '-l', '--format=%(contents)', 'notes').replace(/\n+$/, '')).toBe('Release notes\n\n# not a comment\n- one\n- two');
    expect(repo.git('tag', '-l', '--format=%(contents:subject)', 'notes')).toBe('Release notes');
  });

  test('TAG-03 — "New tag..." from the palette tags the selected commit, or HEAD when none is selected', async ({ app, repo }) => {
    const picked = revParse(repo.path, 'HEAD~4');
    const head = repo.head();

    // Nothing selected but the work-in-progress line (a clean repository): HEAD.
    await app.openPalette('new tag');
    await app.waitFor('palette-item', { commandId: 'tag.create' });
    await app.press('Enter');
    await app.waitFor('tag-create-dialog');
    await expect(app.byTid('tag-create-target')).toHaveText('HEAD (main)');
    await app.press('Escape');
    await app.waitGone('tag-create-dialog');

    // One commit selected: that commit, named by its short id and summary.
    await clickCommitRow(app, picked);
    await expect(app.byTid('graph-row', { oid: picked })).toHaveAttribute('data-selected', 'true');
    await app.openPalette('new tag');
    await app.waitFor('palette-item', { commandId: 'tag.create' });
    await app.press('Enter');
    await app.waitFor('tag-create-dialog');
    await expect(app.byTid('tag-create-target')).toHaveText(`${picked.slice(0, 7)} commit 6`);
    await app.type('tag-create-name-input', 'picked');
    await app.press('Enter');
    await app.idle();
    await app.waitGone('tag-create-dialog');
    await expect(toastSaying(app, 'success', `Tag "picked" created on ${picked.slice(0, 7)}.`)).toBeVisible();
    expect(revParse(repo.path, 'refs/tags/picked')).toBe(picked);
    expect(repo.head()).toBe(head);
  });
});

test.describe('TAG-03 — no commit to tag', () => {
  test.use({ scenario: { fixture: 'empty' } });

  test('TAG-03 — in a repository without commit the "+" is off and says why', async ({ app, repo }) => {
    await expect(app.byTid('sidebar-tag-create-btn')).toBeDisabled();
    await expect(app.byTid('sidebar-tag-create-btn')).toHaveAttribute('title', 'There is no commit to tag yet.');
    expect(repo.refs()).toEqual({});
  });
});

// A stopped merge: creating a tag touches no state, so it is allowed, and the merge stays exactly as it was.
test.describe('TAG-03 — creating a tag while a merge is stopped', () => {
  test.use({
    scenario: {
      fixture: 'rebase-conflict',
      setup: (fx) => {
        fx.git('switch', '-q', 'main');
        if (gitOk(fx.repo, 'merge', 'feature').status === 0) throw new Error('git merge feature had to stop on conflict.txt (fixture rebase-conflict)');
      },
    },
  });

  test('TAG-03 — a tag can be created on the stopped merge; nothing of the merge moves', async ({ app, repo }) => {
    await app.waitFor('op-banner', { kind: 'merge', phase: 'conflict' });
    expect(inProgress(repo.path)).toBe('merge');
    const before = { status: statusPorcelainV2(repo.path), refs: repo.refs(), head: repo.head() };

    await app.click('sidebar-tag-create-btn');
    await app.type('tag-create-name-input', 'mid-merge');
    await app.press('Enter');
    await app.idle();
    await app.waitGone('tag-create-dialog');
    expect(revParse(repo.path, 'refs/tags/mid-merge')).toBe(before.head);
    expect(inProgress(repo.path)).toBe('merge');
    expect(statusPorcelainV2(repo.path)).toEqual(before.status);
    expect(repo.refs()).toEqual({ ...before.refs, 'refs/tags/mid-merge': before.head });
    await app.waitFor('op-banner', { kind: 'merge', phase: 'conflict' });
  });
});
