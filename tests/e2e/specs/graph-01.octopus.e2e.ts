// GRAPH-01 — Graph: opening and lanyards (, 04). Fixture `octopus` (octopus a, b, c + 2 classical merges + orphan branch).
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git } from '../../support/git-state';
import { rowOf } from '../../support/graph';
import { appReady, countOf, until, waitForTestId } from '../../support/ui';

interface LaneInfo {
  lane: number;
  color: number;
  row: number;
  parents: string[];
  /** `[fromLane, toLane, color, flags] × n`: flags bit0 = low half, bit1 = dotted. */
  edges: number[];
}

/** `window.__gitmini.graph.lanesOf`: Lane, colour, parents and edges of the line (the bridge adds `parents` and `edges` to ). */
async function lanesOf(oid: string): Promise<LaneInfo> {
  return browser.execute((o: string) => {
    const g = (window as unknown as { __gitmini: { graph: { lanesOf(o: string): LaneInfo } } }).__gitmini.graph;
    return g.lanesOf(o);
  }, oid);
}

describe("GRAPH-01 — Graph: opening and lanyards", () => {
  it("GRAPH-01 — octopus: one line by commit of git rev-list --all (order git log --date-order), the octapus merge connects 4 parents", async () => {
    const { repo } = currentSession();
    await appReady();
    await waitForTestId('sidebar-local-section');

    // A line by commit: same oids as `git rev-list --all`, in the order of `git log --date-order` (04 "Criteria").
    const all = git(repo, 'rev-list', '--all').split('\n').sort();
    const ordered = git(repo, 'log', '--date-order', '--format=%H', '--branches', '--remotes', '--tags', 'HEAD').split('\n');
    expect([...ordered].sort()).toEqual(all);
    await until(async () => (await countOf('graph-row')) === ordered.length, { message: "one line graph-row by commit" });
    for (const [i, oid] of ordered.entries()) expect(await rowOf(oid)).toBe(i);
    const domOids = await browser.execute(() =>
      [...document.querySelectorAll<HTMLElement>('[data-testid="graph-row"]')]
        .sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index))
        .map((e) => e.dataset.oid),
    );
    expect(domOids).toEqual(ordered);

    // The commit octopus connects 4 parents: 4 edges of the lower half start from its node, towards the lanes of the 4 parents.
    const octopus = git(repo, 'rev-list', '--min-parents=4', '--all');
    const parents = git(repo, 'log', '-1', '--format=%P', octopus).split(' ');
    expect(parents).toHaveLength(4);
    const node = await lanesOf(octopus);
    expect(node.parents).toEqual(parents);
    const parentLanes = (await Promise.all(parents.map((p) => lanesOf(p)))).map((l) => l.lane);
    expect(new Set(parentLanes).size).toBe(4); // quatre lanes distinctes
    const toLanes: number[] = [];
    for (let i = 0; i + 3 < node.edges.length; i += 4) {
      const [from, to, , flags] = [node.edges[i]!, node.edges[i + 1]!, node.edges[i + 2]!, node.edges[i + 3]!];
      if (from === node.lane && (flags & 1) === 1) toLanes.push(to);
    }
    expect(toLanes.sort()).toEqual([...parentLanes].sort());
    // HEAD occupies column 0 of its line (04 "Criteria").
    expect((await lanesOf(git(repo, 'rev-parse', 'HEAD'))).lane).toBe(0);
  });
});
