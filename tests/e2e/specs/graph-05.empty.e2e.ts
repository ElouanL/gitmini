// GRAPH-05 — Graph: empty repository (, 04 "Incorrect case"). Fixture `empty` (HEAD not born).
import { expect } from '@wdio/globals';
import { appReady, countOf, textOf, waitForTestId } from '../../support/ui';

describe("GRAPH-05 — Graph: empty repository", () => {
  it("GRAPH-05 — graph-empty-state \"No commit. Make your first commit.\", no lines, no errors", async () => {
    await appReady();
    await waitForTestId('graph-empty-state');
    expect(await textOf('graph-empty-state')).toBe("Make your first commit.");
    expect(await countOf('graph-row')).toBe(0);
    expect(await countOf('toast[data-kind=error]')).toBe(0);
  });
});
