import { describe, expect, it } from 'vitest';
import { MAX_RECENT_COMMANDS, normalizeRecentCommands } from '../ipc/settings-types';
import { filterCommands, parseQuery, pushRecent, recentEntries, type PaletteEntry } from './palette';

const entries: PaletteEntry[] = [
  { id: 'repo.open', label: 'Open a repository...' },
  { id: 'git.fetch', label: 'Fetch (all remotes)' },
  { id: 'git.pull', label: 'Pull' },
  { id: 'git.pullFfOnly', label: 'Pull (fast-forward only)' },
  { id: 'git.pullRebase', label: 'Pull (rebase)' },
  { id: 'git.push', label: 'Push' },
  { id: 'branch.create', label: 'New branch...' },
  { id: 'stash.save', label: 'Stash changes' },
  { id: 'stash.pop', label: 'Pop the latest stash' },
  { id: 'theme.toggle', label: 'Toggle the light / dark theme' },
  { id: 'graph.search', label: 'Search the graph' },
  { id: 'sidebar.filter', label: 'Filter branches and tags' },
];
const ids = (list: PaletteEntry[]): string[] => list.map((e) => e.id);

describe('parseQuery', () => {
  it("reads plain text as a command search", () => {
    expect(parseQuery('')).toEqual({ mode: 'commands', term: '' });
    expect(parseQuery('  fetch  ')).toEqual({ mode: 'commands', term: 'fetch' });
    expect(parseQuery('pull (rebase)')).toEqual({ mode: 'commands', term: 'pull (rebase)' });
  });

  it("reads a prefix as a search among branches and tags, commits or repositories", () => {
    expect(parseQuery('@')).toEqual({ mode: 'refs', term: '' });
    expect(parseQuery('@ feature/login ')).toEqual({ mode: 'refs', term: 'feature/login' });
    expect(parseQuery('#fix typo')).toEqual({ mode: 'commits', term: 'fix typo' });
    expect(parseQuery('/api')).toEqual({ mode: 'repos', term: 'api' });
    expect(parseQuery('   /api')).toEqual({ mode: 'repos', term: 'api' });
  });

  it("only the first character is a prefix", () => {
    expect(parseQuery('mail@home')).toEqual({ mode: 'commands', term: 'mail@home' });
    expect(parseQuery('@#/')).toEqual({ mode: 'refs', term: '#/' });
  });
});

describe('filterCommands', () => {
  it("returns the entries untouched for an empty query", () => {
    expect(filterCommands(entries, '')).toBe(entries);
    expect(filterCommands(entries, '   ')).toBe(entries);
  });

  it("ranks the exact label first, then the other matches by how well they fit", () => {
    expect(ids(filterCommands(entries, 'pull'))).toEqual(['git.pull', 'git.pullRebase', 'git.pullFfOnly']);
    expect(ids(filterCommands(entries, 'push'))[0]).toBe('git.push');
  });

  it("accepts letters that are not next to each other (fuzzy) and several words", () => {
    expect(ids(filterCommands(entries, 'stch'))[0]).toBe('stash.save');
    expect(ids(filterCommands(entries, 'tgl theme'))).toEqual(['theme.toggle']);
    expect(ids(filterCommands(entries, 'filter bra'))).toEqual(['sidebar.filter']);
    expect(ids(filterCommands(entries, 'zzz'))).toEqual([]);
  });

  it("ignores case and accents", () => {
    expect(ids(filterCommands(entries, 'FETCH'))).toEqual(['git.fetch']);
    expect(ids(filterCommands([{ id: 'x.open', label: 'Ouvrir un dépôt' }], 'depot'))).toEqual(['x.open']);
  });

  it("falls back to the id, below every label match", () => {
    const list = [...entries, { id: 'view.reflog', label: 'Show / hide the history of moves' }];
    expect(ids(filterCommands(list, 'reflog'))).toEqual(['view.reflog']);
    // Several commands matching on the id alone keep their order.
    expect(ids(filterCommands(list, 'git.pull'))).toEqual(['git.pull', 'git.pullFfOnly', 'git.pullRebase']);
    // A label match leads an id-only match: "view" is in the id of the first and in the label of the second.
    const mixed: PaletteEntry[] = [{ id: 'view.reflog', label: 'Show the history' }, { id: 'x.y', label: 'Preview' }];
    expect(ids(filterCommands(mixed, 'view'))).toEqual(['x.y', 'view.reflog']);
  });

  it("flags the matched characters of the label for highlighting", () => {
    expect(filterCommands(entries, 'fetch')[0]!.match).toEqual([0, 1, 2, 3, 4]);
    // an id-only match highlights nothing
    expect(filterCommands([{ id: 'view.reflog', label: 'Show the history' }], 'reflog')[0]!.match).toBeUndefined();
  });

  it("puts a command run recently above an equally good one", () => {
    const list: PaletteEntry[] = [{ id: 'a', label: 'Pull now' }, { id: 'b', label: 'Pull now' }];
    expect(ids(filterCommands(list, 'pull'))).toEqual(['a', 'b']);
    expect(ids(filterCommands(list, 'pull', ['b']))).toEqual(['b', 'a']);
  });

  it("does not let recency beat a clearly better match", () => {
    const list: PaletteEntry[] = [{ id: 'far', label: 'Push the ultimate lines' }, { id: 'exact', label: 'Pull' }];
    expect(ids(filterCommands(list, 'pull', ['far']))).toEqual(['exact', 'far']);
  });
});

describe('recent commands', () => {
  it("pushRecent puts the command first, once, and keeps at most `max`", () => {
    expect(pushRecent([], 'a')).toEqual(['a']);
    expect(pushRecent(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
    expect(pushRecent(['a', 'b'], 'c', 2)).toEqual(['c', 'a']);
    const many = Array.from({ length: 20 }, (_, i) => `cmd.${i}`);
    expect(pushRecent(many, 'new')).toHaveLength(MAX_RECENT_COMMANDS);
    expect(pushRecent(many, 'new')[0]).toBe('new');
  });

  it("recentEntries keeps the order of use and drops commands that cannot be listed now", () => {
    expect(ids(recentEntries(entries, ['theme.toggle', 'gone.away', 'git.fetch']))).toEqual(['theme.toggle', 'git.fetch']);
    expect(recentEntries(entries, [])).toEqual([]);
  });

  it("normalizeRecentCommands accepts what the settings file holds and nothing else", () => {
    expect(normalizeRecentCommands(['git.fetch', 'theme.toggle'])).toEqual(['git.fetch', 'theme.toggle']);
    expect(normalizeRecentCommands(['a', 'b', 'a'])).toEqual(['a', 'b']);
    expect(normalizeRecentCommands(['a', 3, '', null, 'b'])).toEqual(['a', 'b']);
    expect(normalizeRecentCommands('git.fetch')).toEqual([]);
    expect(normalizeRecentCommands(undefined)).toEqual([]);
    expect(normalizeRecentCommands(Array.from({ length: 30 }, (_, i) => `c${i}`))).toHaveLength(MAX_RECENT_COMMANDS);
  });
});
