// GRAPH-02 — Graph: selection and details (, , 03 "Right Panel"). Fixture `linear`.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, revParse } from '../../support/git-state';
import { clickRow } from '../../support/graph';
import { appReady, attrOf, idle, textOf, until, waitForTestId } from '../../support/ui';

const CHANGE: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', T: 'typechange' };

/** `git … --name-status` → `[chemin, ChangeKind]` (renames excluded: the fixture does not contain one). */
function expectedFiles(output: string): [string, string][] {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, path] = line.split('\t');
      return [path!, CHANGE[status![0]!]!] as [string, string];
    });
}

async function listedFiles(): Promise<[string, string][]> {
  const items = await browser.execute(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid="commit-details-file-item"]')].map((e) => ({ path: e.dataset.path!, change: e.dataset.change! })),
  );
  return items.map((i) => [i.path, i.change]);
}

describe("GRAPH-02 — Graph : selection and details", () => {
  it("GRAPH-02 — click on HEAD~3 : commit-details-panel and files = git ; Mod+click on HEAD~1 : files = git diff --name-status between the two", async () => {
    const { repo } = currentSession();
    await appReady();

    // A commit: message, author, OID and `git diff-tree` files.
    const oid = revParse(repo, 'HEAD~3');
    await clickRow(oid);
    await idle();
    await waitForTestId('commit-details-panel', { attrs: { oid } });
    // The panel displays the complete OID, message and author (03 "Right Panel").
    const shown = await textOf('commit-details-panel');
    expect(shown).toContain(oid);
    expect(shown).toContain(git(repo, 'log', '-1', '--format=%s', oid));
    expect(shown).toContain('Fixture Bot');
    await until(async () => (await listedFiles()).length > 0, { message: "commit file list" });
    expect(await listedFiles()).toEqual(expectedFiles(git(repo, 'diff-tree', '--no-commit-id', '--name-status', '-r', oid)));
    expect(await attrOf('graph-row', 'data-index', { selected: 'true' })).toBe('3');

    // Two commits (Mod+click): multi-commit-panel, files = `git diff --name-status <older> <newer>`.
    const newer = revParse(repo, 'HEAD~1');
    await clickRow(newer, { mod: true });
    await idle();
    await waitForTestId('multi-commit-panel');
    expect(await attrOf('multi-commit-panel', 'data-count')).toBe('2');
    const expected = expectedFiles(git(repo, 'diff', '--name-status', oid, newer));
    await until(async () => JSON.stringify(await listedFiles()) === JSON.stringify(expected), { message: "files between the two commits" });
    expect(expected.length).toBeGreaterThan(0);

    // A click on a file opens its diff in the central area (source "range" old → recent).
    await browser.execute(() => document.querySelector<HTMLElement>('[data-testid="commit-details-file-item"]')!.click());
    await idle();
    await waitForTestId('diff-viewer');
  });
});
