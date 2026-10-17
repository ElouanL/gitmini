import { describe, expect, it } from 'vitest';
import type { RecentRepo, RefsSnapshot } from '../ipc/types';
import { Session } from '../stores/session.svelte';
import { makeBranch, makeLogPage, makeRefs, oid } from '../test/fixtures';
import {
  commandSections, commitChoice, commitSections, compactPath, itemsOf, loadedCommits, MAX_ITEMS, occurrence, refSections, repoSections, resultsStatus, toRows,
  type CommitItem, type OpenTab, type PaletteItem, type RefItem, type RepoItem,
} from './palette-entities';
import type { PaletteEntry } from './palette';

const labels = (items: readonly PaletteItem[]): string[] => items.map((i) => i.label);
const entries: PaletteEntry[] = [
  { id: 'git.fetch', label: 'Fetch (all remotes)' },
  { id: 'git.pull', label: 'Pull' },
  { id: 'theme.toggle', label: 'Toggle the light / dark theme' },
];

describe('toRows', () => {
  it("draws a heading before its items, numbers the items across sections and skips empty sections", () => {
    const sections = commandSections(entries, '', ['theme.toggle']);
    const rows = toRows([...sections, { id: 'empty', label: 'Nothing', items: [] }]);
    expect(rows.map((r) => (r.type === 'header' ? `# ${r.label}` : `${r.index} ${r.item.label}`))).toEqual([
      '# Recently used', '0 Toggle the light / dark theme', '# All commands', '1 Fetch (all remotes)', '2 Pull',
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });

  it("an unlabeled section has no heading", () => {
    expect(toRows(commandSections(entries, 'pull', [])).map((r) => r.type)).toEqual(['item']);
  });
});

describe('commandSections', () => {
  it("lists every command under one unlabeled section when nothing was run yet", () => {
    const sections = commandSections(entries, '', []);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.label).toBeNull();
    expect(labels(sections[0]!.items)).toEqual(['Fetch (all remotes)', 'Pull', 'Toggle the light / dark theme']);
  });

  it("puts the commands run last first, most recent first, and does not repeat them below", () => {
    const [recent, rest] = commandSections(entries, '', ['theme.toggle', 'git.fetch', 'gone.away']);
    expect(recent).toMatchObject({ id: 'recent', label: 'Recently used' });
    expect(labels(recent!.items)).toEqual(['Toggle the light / dark theme', 'Fetch (all remotes)']);
    expect(rest).toMatchObject({ id: 'commands', label: 'All commands' });
    expect(labels(rest!.items)).toEqual(['Pull']);
  });

  it("typed text gives one ranked list with the recent command boosted, not grouped", () => {
    const sections = commandSections(entries, 'pull', ['git.fetch']);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.items).toMatchObject([{ kind: 'command', id: 'git.pull', match: [0, 1, 2, 3] }]);
  });
});

describe('refSections', () => {
  const snapshot: RefsSnapshot = {
    ...makeRefs(),
    head: { kind: 'branch', name: 'main' },
  };

  it("groups local branches, remote branches and tags, in the backend's order", () => {
    const sections = refSections(snapshot, '', true);
    expect(sections.map((s) => [s.label, labels(s.items)])).toEqual([
      ['Branches', ['main', 'feature/login', 'fix/typo', 'topic']],
      ['Remote branches', ['origin/main', 'origin/feature/login']],
      ['Tags', ['v0.1.0', 'v0.2.0']],
    ]);
  });

  it("a branch jumps to its tip, a remote branch to its own tip, a tag to the commit it points to", () => {
    const items = itemsOf(refSections(snapshot, '', true)) as RefItem[];
    const byName = (n: string) => items.find((i) => i.label === n)!;
    expect(byName('feature/login')).toMatchObject({ refKind: 'local', oid: oid(55) });
    expect(byName('origin/main')).toMatchObject({ refKind: 'remote', oid: oid(58) });
    // v0.2.0 is annotated: its own object is oid(1020), the commit it tags is oid(40)
    expect(byName('v0.2.0')).toMatchObject({ refKind: 'tag', oid: oid(40) });
  });

  it("offers a checkout like the sidebar does, except on the current branch", () => {
    const items = itemsOf(refSections(snapshot, '', true)) as RefItem[];
    const byName = (n: string) => items.find((i) => i.label === n)!;
    expect(byName('main').checkout).toBeNull();
    expect(byName('main')).toMatchObject({ current: true, badge: 'current' });
    expect(byName('fix/typo').checkout).toEqual({ kind: 'local', name: 'fix/typo' });
    expect(byName('origin/feature/login').checkout).toEqual({ kind: 'remote', ref: 'origin/feature/login' });
    expect(byName('v0.2.0').checkout).toEqual({ kind: 'detached', oid: oid(40) });
  });

  it("offers no checkout at all while a write is in flight (the jump stays available)", () => {
    const items = itemsOf(refSections(snapshot, '', false)) as RefItem[];
    expect(items.every((i) => i.checkout === null)).toBe(true);
    expect(items.map((i) => i.oid).every(Boolean)).toBe(true);
  });

  it("typed text gives one list ranked by fuzzy match on the name, with the matched letters", () => {
    const sections = refSections(snapshot, 'login', true);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.label).toBeNull();
    expect(labels(sections[0]!.items)).toEqual(['feature/login', 'origin/feature/login']);
    expect((sections[0]!.items[0] as RefItem).match).toEqual([8, 9, 10, 11, 12]);
    expect(labels(itemsOf(refSections(snapshot, 'v0.2', true)))).toEqual(['v0.2.0']);
    expect(refSections(snapshot, 'zzzz', true)[0]!.items).toEqual([]);
  });

  it("tells the kinds apart by badge", () => {
    const items = itemsOf(refSections(snapshot, '', true)) as RefItem[];
    const badge = (n: string) => items.find((i) => i.label === n)?.badge;
    expect([badge('topic'), badge('origin/main'), badge('v0.1.0')]).toEqual(['branch', 'remote', 'tag']);
  });

  it("is empty without a snapshot (no repository)", () => {
    expect(refSections(null, '', true)).toEqual([]);
    expect(refSections(null, 'x', true)).toEqual([]);
  });

  it("stops listing at MAX_ITEMS so a repository with thousands of tags stays usable", () => {
    const tags = Array.from({ length: 500 }, (_, i) => ({ name: `v${i}`, fullRef: `refs/tags/v${i}`, oid: oid(i + 1), targetOid: oid(i + 1), annotated: false }));
    const many: RefsSnapshot = { ...snapshot, local: [makeBranch('main', 60, { isHead: true })], tags };
    expect(itemsOf(refSections(many, '', true))).toHaveLength(MAX_ITEMS);
    expect(itemsOf(refSections(many, 'v', true))).toHaveLength(MAX_ITEMS);
    // a precise search still finds the one that was cut from the unfiltered list
    expect(labels(itemsOf(refSections(many, 'v499', true)))[0]).toBe('v499');
  });

  it("keys are unique even when a branch and a tag share a name", () => {
    const both: RefsSnapshot = { ...snapshot, local: [makeBranch('v1', 1)], remote: [], tags: [{ name: 'v1', fullRef: 'refs/tags/v1', oid: oid(2), targetOid: oid(2), annotated: false }] };
    const keys = itemsOf(refSections(both, '', true)).map((i) => i.key);
    expect(new Set(keys).size).toBe(2);
  });
});

describe('commits', () => {
  const page = makeLogPage(60, 60);

  it("loadedCommits lists the newest commits first, once each, without stash rows", () => {
    const withStash = { ...page, rows: [{ ...page.rows[1]!, kind: 'stash' as const, oid: oid(900) }, ...page.rows] };
    const out = loadedCommits([withStash, page], 5);
    expect(out.map((c) => c.oid)).toEqual([oid(60), oid(59), oid(58), oid(57), oid(56)]);
    expect(loadedCommits([withStash, page, page], 1000)).toHaveLength(60);
    expect(loadedCommits([])).toEqual([]);
  });

  it("a commit carries its subject and the names of its branches and tags", () => {
    expect(commitChoice(page.rows[0]!)).toEqual({ oid: oid(60), summary: 'feat: login form', refs: ['main', 'origin/main'] });
  });

  it("commitSections shows the subject, the short sha and the refs on the commit", () => {
    const [section] = commitSections([commitChoice(page.rows[0]!), commitChoice(page.rows[5]!)], '');
    expect(section).toMatchObject({ id: 'commits', label: 'Latest commits' });
    const [tip, other] = section!.items as CommitItem[];
    expect(tip).toMatchObject({ kind: 'commit', oid: oid(60), label: 'feat: login form', detail: oid(60).slice(0, 7), badge: 'main, origin/main' });
    expect(other).toMatchObject({ oid: oid(55), badge: 'feature/login' });
  });

  it("shows the first two refs and counts the rest", () => {
    const [section] = commitSections([{ oid: oid(1), summary: 's', refs: ['a', 'b', 'c', 'd'] }], 'x');
    expect(section!.items[0]!.badge).toBe('a, b +2');
  });

  it("with a term, the list has no heading and the matched text is highlighted", () => {
    const [section] = commitSections([commitChoice(page.rows[0]!)], 'LOGIN');
    expect(section!.label).toBeNull();
    expect(section!.items[0]!.match).toEqual([6, 7, 8, 9, 10]);
  });

  it("a commit without subject still gets a label", () => {
    expect(commitSections([{ oid: oid(1), summary: '', refs: [] }], '')[0]!.items[0]!.label).toBe('(no subject)');
  });

  it("occurrence finds the first occurrence ignoring case and accents, nothing when absent", () => {
    expect(occurrence('Café', 'Un cafe noir')).toEqual([3, 4, 5, 6]);
    expect(occurrence('zz', 'abc')).toEqual([]);
    expect(occurrence('  ', 'abc')).toEqual([]);
    expect(occurrence('a1b2', 'fix a1b2')).toEqual([4, 5, 6, 7]);
  });
});

describe('repoSections', () => {
  const [one, two] = [new Session(), new Session()];
  const tabs: OpenTab[] = [
    { session: one, name: 'gitmini', path: '/dev/gitmini' },
    { session: two, name: 'api-server', path: '/dev/api-server' },
  ];
  const recents: RecentRepo[] = [
    { path: '/dev/gitmini/', name: 'gitmini', lastOpened: '2026-10-01T10:00:00Z' },
    { path: '/dev/website', name: 'website', lastOpened: '2026-09-01T10:00:00Z' },
    { path: '/old/api-server', name: 'api-server', lastOpened: '2026-08-01T10:00:00Z' },
  ];

  it("lists the open tabs, then the recent repositories that are not open", () => {
    const sections = repoSections(tabs, one, recents, '');
    expect(sections.map((s) => [s.label, labels(s.items)])).toEqual([
      ['Open repositories', ['gitmini', 'api-server']],
      ['Recent repositories', ['website', 'api-server']], // /dev/gitmini/ is the open tab (trailing slash)
    ]);
  });

  it("shows the end of a long path and keeps the whole one as the tooltip", () => {
    const long = '/Users/someone/very/deep/folders/of/projects/client-work/api-server';
    const [item] = itemsOf(repoSections([{ session: one, name: 'api-server', path: long }], one, [], '')) as RepoItem[];
    expect(item!.title).toBe(long);
    expect(item!.detail!.length).toBeLessThanOrEqual(44);
    expect(item!.detail!.startsWith('…/')).toBe(true);
    expect(item!.detail!.endsWith('/api-server')).toBe(true);
    // a short path is left alone
    expect(compactPath('/dev/api-server')).toBe('/dev/api-server');
    // no folder boundary near the front: cut where it falls
    expect(compactPath('x'.repeat(100), 20)).toBe(`…${'x'.repeat(19)}`);
    expect(compactPath('C:\\Users\\someone\\projects\\client-work\\api-server', 30)).toBe('…\\client-work\\api-server');
  });

  it("marks the active tab and opens a tab by its session", () => {
    const items = itemsOf(repoSections(tabs, two, recents, '')) as RepoItem[];
    expect(items[0]).toMatchObject({ kind: 'repo', path: '/dev/gitmini', tab: one, current: false, badge: 'open', detail: '/dev/gitmini' });
    expect(items[1]).toMatchObject({ tab: two, current: true, badge: 'current' });
    expect(items[2]).toMatchObject({ path: '/dev/website', tab: null, current: false, badge: null });
  });

  it("typed text gives one ranked list matching the name, then the path", () => {
    const items = itemsOf(repoSections(tabs, one, recents, 'api')) as RepoItem[];
    expect(items.map((i) => i.path)).toEqual(['/dev/api-server', '/old/api-server']);
    expect(items[0]!.match).toEqual([0, 1, 2]);
    // "old" is only in a path: found, after the name matches, nothing highlighted
    const byPath = itemsOf(repoSections(tabs, one, recents, 'old')) as RepoItem[];
    expect(byPath.map((i) => i.path)).toEqual(['/old/api-server']);
    expect(byPath[0]!.match).toEqual([]);
    expect(itemsOf(repoSections(tabs, one, recents, 'zzzz'))).toEqual([]);
    // a path is searched as plain text: scattered letters of "/dev/website" do not make "dvw" a match
    expect(itemsOf(repoSections(tabs, one, recents, 'dvw'))).toEqual([]);
  });

  it("works without any open tab (welcome screen)", () => {
    const items = itemsOf(repoSections([], null, recents, '')) as RepoItem[];
    expect(items.map((i) => i.tab)).toEqual([null, null, null]);
    expect(labels(items)).toEqual(['gitmini', 'website', 'api-server']);
  });

  it("keys stay unique when a tab and a recent entry share a name", () => {
    const keys = itemsOf(repoSections(tabs, one, recents, '')).map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('resultsStatus', () => {
  it("says how many results there are, for a screen reader", () => {
    expect([resultsStatus(0), resultsStatus(1), resultsStatus(12)]).toEqual(['No results', '1 result', '12 results']);
  });
});
