// GRAPH-06 — Graph: outdated cursor (04 "In error case", level I for backend; here the behavior of the interface).
// `linear` Fixture: an external commit while HEAD~5 is selected.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, revParse } from '../../support/git-state';
import { clickRow, eventCount, rowOf, visibleRange } from '../../support/graph';
import { appReady, attrOf, countOf, idle, until, waitForTestId } from '../../support/ui';

describe("GRAPH-06 — Graph: outdated cursor", () => {
  it("GRAPH-06 — git commit external with HEAD~5 selected: same oid selected and visible, new commit head, no toast", async () => {
    const { repo } = currentSession();
    await appReady();

    const oid = revParse(repo, 'HEAD~5');
    await clickRow(oid);
    await idle();
    await waitForTestId('commit-details-panel', { attrs: { oid } });
    const before = await eventCount('repo:changed');

    git(repo, 'commit', '--allow-empty', '-m', 'commit externe');
    await until(async () => (await eventCount('repo:changed')) > before, { message: "repo:changed from external commit" });
    await idle();

    const newHead = revParse(repo, 'HEAD');
    await until(async () => (await rowOf(newHead)) === 0, { message: "the new commit is the first line of the graph" });
    // The selection follows the commit by oid (never by row) and remains visible; no message is displayed.
    expect(await attrOf('graph-row', 'data-oid', { selected: 'true' })).toBe(oid);
    expect(await attrOf('commit-details-panel', 'data-oid')).toBe(oid);
    const row = await rowOf(oid);
    expect(row).toBe(6); // a line lower than before the commit
    const range = await visibleRange();
    expect(range.first).toBeLessThanOrEqual(row);
    expect(range.last).toBeGreaterThanOrEqual(row);
    expect(await countOf('toast')).toBe(0);
  });
});
