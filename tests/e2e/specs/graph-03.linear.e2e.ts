// GRAPH-03 — Graph : search (, ) Fixture `linear`. The budget of log_search is measured by PERF-16.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git } from '../../support/git-state';
import { appReady, attrOf, idle, press, textOf, typeInto, until, waitForGone, waitForTestId } from '../../support/ui';

const selectedOid = (): Promise<string | null> => attrOf('graph-row', 'data-oid', { selected: 'true' });

describe('GRAPH-03 — Graphe : recherche', () => {
  it("GRAPH-03 — Mod+F and then \"commit 7\": selected result, 1 / 1 ; author: = git log --author; Enter / Escape", async () => {
    const { repo } = currentSession();
    await appReady();

    await press('Mod+F');
    await waitForTestId('graph-search');
    await typeInto('graph-search-input', 'commit 7');
    await until(async () => (await textOf('graph-search-count')) === '1 / 1', { message: 'compteur 1 / 1' });
    await idle();
    expect(await selectedOid()).toBe(git(repo, 'log', '--format=%H', '--grep=commit 7'));

    // `author:` prefix: counter = author's number of commits; input goes to the next (next row of the graph).
    await typeInto('graph-search-input', 'author:fixture');
    const count = git(repo, 'log', '--all', '--author=fixture', '--format=%H').split('\n').length;
    await until(async () => (await textOf('graph-search-count')) === `1 / ${count}`, { message: `compteur 1 / ${count}` });
    await idle();
    const first = await selectedOid();
    await press('Enter');
    await until(async () => (await textOf('graph-search-count')) === `2 / ${count}`, { message: "Next result" });
    await idle();
    expect(await selectedOid()).not.toBe(first);

    // Without result: 0 / 0 and error border, without toast.
    await typeInto('graph-search-input', 'introuvable-xyz');
    await until(async () => (await textOf('graph-search-count')) === '0 / 0', { message: 'compteur 0 / 0' });
    expect(await attrOf('graph-search-input', 'data-empty-result')).toBe('true');

    // Escape closes the bar and keeps the current selection.
    await typeInto('graph-search-input', 'commit 7');
    await until(async () => (await textOf('graph-search-count')) === '1 / 1');
    const kept = await selectedOid();
    await press('Escape');
    await waitForGone('graph-search');
    expect(await selectedOid()).toBe(kept);
  });
});
