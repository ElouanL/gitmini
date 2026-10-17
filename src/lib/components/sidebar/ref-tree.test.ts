// Pure logic of the sidebar lists: prefix folders and filter.
import { describe, expect, it } from 'vitest';
import { buildRows, filterItems, filterTerms, flattenTree, folderPaths, groupByPrefix, matchesTerms, treePositions, type RefRow } from './ref-tree';

const name = (s: string) => s;
const open = () => true;

/** Compact view of the rows: `d:<path>(<count>)` for a folder, `<label>` for a leaf, indented by depth. */
function shape(rows: readonly RefRow<string>[]): string[] {
  return rows.map((r) => `${'  '.repeat(r.depth)}${r.kind === 'folder' ? `d:${r.path}(${r.count})${r.open ? '' : ' closed'}` : r.label}`);
}

describe('folderPaths', () => {
  it('lists the folders above a name, outermost first; none for a flat or invalid name', () => {
    expect(folderPaths('feature/ui/button')).toEqual(['feature', 'feature/ui']);
    expect(folderPaths('feature/login')).toEqual(['feature']);
    expect(folderPaths('main')).toEqual([]);
    expect(folderPaths('a//b')).toEqual([]);
    expect(folderPaths('/a')).toEqual([]);
  });
});

describe('treePositions', () => {
  const at = (rows: readonly RefRow<string>[], base?: number) => treePositions(rows, base).map((p) => `${p.level}:${p.posinset}/${p.setsize}`);

  it('numbers the siblings of each parent, whatever their depth, and counts the levels from the top', () => {
    const rows = buildRows(['main', 'feature/a', 'feature/ui/x', 'feature/ui/y', 'feature/b', 'topic'], name, open);
    expect(shape(rows)).toEqual(['main', 'd:feature(4)', '  a', '  d:feature/ui(2)', '    x', '    y', '  b', 'topic']);
    // main, feature, (a, ui, (x, y), b), topic
    expect(at(rows)).toEqual(['1:1/3', '1:2/3', '2:1/3', '2:2/3', '3:1/2', '3:2/2', '2:3/3', '1:3/3']);
    expect(at(rows, 2)[0]).toBe('2:1/3'); // under a remote
  });

  it('counts only the rows that are listed: a closed folder is one row, its children are not there', () => {
    const rows = buildRows(['feature/a', 'feature/b', 'topic'], name, (path) => path !== 'feature');
    expect(shape(rows)).toEqual(['d:feature(2) closed', 'topic']);
    expect(at(rows)).toEqual(['1:1/2', '1:2/2']);
    expect(at([])).toEqual([]);
  });
});

describe('groupByPrefix', () => {
  it('puts names without a slash at the root and the others under a folder, labelled by their last segment', () => {
    const rows = buildRows(['main', 'feature/login', 'feature/signup', 'topic'], name, open);
    expect(shape(rows)).toEqual(['main', 'd:feature(2)', '  login', '  signup', 'topic']);
    const leaf = rows.find((r) => r.kind === 'leaf' && r.label === 'login')!;
    expect(leaf.kind === 'leaf' && leaf.item).toBe('feature/login');
  });

  it('keeps the backend order: a folder sits at its first member and gathers the others', () => {
    // Current branch first, then alphabetical: `feature/b` is current and drags its folder to the top.
    const rows = buildRows(['feature/b', 'a', 'feature/a', 'z'], name, open);
    expect(shape(rows)).toEqual(['d:feature(2)', '  b', '  a', 'a', 'z']);
  });

  it('nests folders for several levels and counts the leaves at any depth', () => {
    const rows = buildRows(['users/alice/fix', 'users/alice/wip', 'users/bob/spike', 'users/readme'], name, open);
    expect(shape(rows)).toEqual(['d:users(4)', '  d:users/alice(2)', '    fix', '    wip', '  d:users/bob(1)', '    spike', '  readme']);
  });

  it('makes a folder out of a prefix with a single member', () => {
    expect(shape(buildRows(['fix/typo'], name, open))).toEqual(['d:fix(1)', '  typo']);
  });

  it('treats prefixes case-sensitively', () => {
    expect(shape(buildRows(['Feature/a', 'feature/b'], name, open))).toEqual(['d:Feature(1)', '  a', 'd:feature(1)', '  b']);
  });

  it('keeps a name with an empty segment as a plain leaf', () => {
    expect(shape(buildRows(['a//b', '/c', 'd/'], name, open))).toEqual(['a//b', '/c', 'd/']);
  });

  it('keeps a leaf and a folder of the same name apart', () => {
    const rows = buildRows(['v1', 'v1/rc'], name, open);
    expect(shape(rows)).toEqual(['v1', 'd:v1(1)', '  rc']);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });

  it('flags the folders above a flagged item', () => {
    const tree = groupByPrefix(['a/b/c', 'a/d', 'e/f'], name, (n) => n === 'a/b/c');
    const flagged = (nodes: typeof tree): string[] => nodes.flatMap((n) => (n.kind === 'folder' ? [...(n.flagged ? [n.path] : []), ...flagged(n.children)] : []));
    expect(flagged(tree)).toEqual(['a', 'a/b']);
  });

  it('returns an empty list for no item', () => {
    expect(buildRows([], name, open)).toEqual([]);
  });
});

describe('flattenTree', () => {
  it('skips the children of a closed folder and reports the state on the row', () => {
    const tree = groupByPrefix(['a/b/c', 'a/d', 'e'], name);
    expect(shape(flattenTree(tree, (path) => path !== 'a/b'))).toEqual(['d:a(2)', '  d:a/b(1) closed', '  d', 'e']);
    expect(shape(flattenTree(tree, (path) => path !== 'a'))).toEqual(['d:a(2) closed', 'e']);
  });

  it('gives every row a distinct key', () => {
    const rows = buildRows(['a/b', 'a/c', 'b', 'c/d'], name, open);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
});

describe('filter', () => {
  it('splits the query on blanks and ignores case and accents', () => {
    expect(filterTerms('  Fix   TYPO ')).toEqual(['fix', 'typo']);
    expect(filterTerms('Écran')).toEqual(['ecran']);
    expect(filterTerms('   ')).toEqual([]);
    expect(filterTerms('')).toEqual([]);
  });

  it('matches when every term is a substring, in any order', () => {
    const terms = filterTerms('typo fix');
    expect(matchesTerms('fix/typo', terms)).toBe(true);
    expect(matchesTerms('fix/other', terms)).toBe(false);
    expect(matchesTerms('feature/Écran', filterTerms('ecran'))).toBe(true);
    expect(matchesTerms('origin/feature/login', filterTerms('origin/feat'))).toBe(true);
    expect(matchesTerms('anything', [])).toBe(true);
  });

  it('keeps the original order and returns the same list when there is nothing to filter', () => {
    const items = ['b/x', 'a/x', 'a/y'];
    expect(filterItems(items, filterTerms('x'), name)).toEqual(['b/x', 'a/x']);
    expect(filterItems(items, [], name)).toBe(items);
    expect(filterItems(items, filterTerms('zzz'), name)).toEqual([]);
  });
});
