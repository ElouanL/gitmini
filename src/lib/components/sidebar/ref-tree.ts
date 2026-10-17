// Pure logic of the sidebar reference lists: folders by name prefix (`feature/login` lives in the `feature` folder)
// and the filter box. No store, no DOM: the component feeds it the lists and the open/closed state.
import { normalize } from '../../actions/palette';

export interface FolderNode<T> {
  kind: 'folder';
  /** Full prefix, unique in a list (`feature/ui`). */
  path: string;
  /** Last segment of the prefix, displayed (`ui`). */
  name: string;
  children: RefNode<T>[];
  /** Leaves under this folder, at any depth. */
  count: number;
  /** At least one leaf under this folder satisfies the `flag` predicate (e.g. it is the current branch). */
  flagged: boolean;
}

export interface LeafNode<T> {
  kind: 'leaf';
  /** Full name (`feature/login`). */
  path: string;
  /** Last segment, displayed (`login`). */
  name: string;
  item: T;
}

export type RefNode<T> = FolderNode<T> | LeafNode<T>;

export interface FolderRow {
  kind: 'folder';
  /** Unique in a list, usable as keyed-each key. */
  key: string;
  path: string;
  name: string;
  depth: number;
  count: number;
  flagged: boolean;
  open: boolean;
}

export interface LeafRow<T> {
  kind: 'leaf';
  key: string;
  /** Displayed name: the last segment of the full name. */
  label: string;
  depth: number;
  item: T;
}

export type RefRow<T> = FolderRow | LeafRow<T>;

/**
 * Groups names by their `/`-separated prefixes. The order of `items` is kept (the backend sorts, the front does not
 * re-sort): a folder sits where its first member sits and gathers all its members. A prefix with a single member is
 * still a folder, so a list does not reshuffle when a second branch appears. A name with an empty segment
 * (`a//b`, `/a`, `a/`) is not a valid ref name and stays a plain leaf.
 */
export function groupByPrefix<T>(items: readonly T[], nameOf: (item: T) => string, flag?: (item: T) => boolean): RefNode<T>[] {
  const root: RefNode<T>[] = [];
  const folders = new Map<string, FolderNode<T>>();
  for (const item of items) {
    const full = nameOf(item);
    const parts = full.split('/');
    const flat = parts.length < 2 || parts.includes('');
    const flagged = flag?.(item) ?? false;
    let siblings = root;
    if (!flat) {
      let path = '';
      for (const part of parts.slice(0, -1)) {
        path = path === '' ? part : `${path}/${part}`;
        let folder = folders.get(path);
        if (!folder) {
          folder = { kind: 'folder', path, name: part, children: [], count: 0, flagged: false };
          folders.set(path, folder);
          siblings.push(folder);
        }
        folder.count += 1;
        if (flagged) folder.flagged = true;
        siblings = folder.children;
      }
    }
    siblings.push({ kind: 'leaf', path: full, name: flat ? full : (parts[parts.length - 1] as string), item });
  }
  return root;
}

/** Prefix folders above a name, outermost first (`feature/ui/x` gives `feature`, `feature/ui`); none for a flat or invalid name. */
export function folderPaths(name: string): string[] {
  const parts = name.split('/');
  if (parts.length < 2 || parts.includes('')) return [];
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
}

/** Key of a section (`local`, `remote`, `tags`, `stashes`) in the open/closed state of the sidebar. */
export const sectionKey = (section: string): string => `s:${section}`;

/** Key of a prefix folder in that state; `scope` tells the lists apart: `local`, `tags` or `remote:<name>`. */
export const folderKey = (scope: string, path: string): string => `f:${scope}:${path}`;

/** Depth-first flattening of the tree into display rows; the children of a closed folder are skipped. */
export function flattenTree<T>(nodes: readonly RefNode<T>[], isOpen: (folderPath: string) => boolean, depth = 0, out: RefRow<T>[] = []): RefRow<T>[] {
  for (const node of nodes) {
    if (node.kind === 'leaf') {
      out.push({ kind: 'leaf', key: `l:${node.path}`, label: node.name, depth, item: node.item });
      continue;
    }
    const open = isOpen(node.path);
    out.push({ kind: 'folder', key: `d:${node.path}`, path: node.path, name: node.name, depth, count: node.count, flagged: node.flagged, open });
    if (open) flattenTree(node.children, isOpen, depth + 1, out);
  }
  return out;
}

/** Rows to display for a list: grouping by prefix, then flattening according to the open state of each folder. */
export function buildRows<T>(items: readonly T[], nameOf: (item: T) => string, isOpen: (folderPath: string) => boolean, flag?: (item: T) => boolean): RefRow<T>[] {
  return flattenTree(groupByPrefix(items, nameOf, flag), isOpen);
}

/** What a screen reader is told of a row of a tree drawn flat: `aria-level`, `aria-posinset`, `aria-setsize`. */
export interface TreePosition {
  level: number;
  posinset: number;
  setsize: number;
}

/**
 * ARIA position of every row of a flattened tree (see `flattenTree`). `base` is the level of the top rows: 1, or 2 when the
 * list hangs under a parent item (the branches of a remote). The children of a closed folder are not in `rows` and do not
 * need a position; the rows that are there are all the siblings of their parent.
 */
export function treePositions(rows: readonly { depth: number }[], base = 1): TreePosition[] {
  const groups: TreePosition[][] = [];
  // Siblings met so far under the current parent, one list per depth; going back up forgets the deeper ones.
  const current: TreePosition[][] = [];
  const out = rows.map((row) => {
    current.length = row.depth + 1;
    let group = current[row.depth];
    if (!group) {
      group = [];
      current[row.depth] = group;
      groups.push(group);
    }
    const position: TreePosition = { level: row.depth + base, posinset: group.length + 1, setsize: 0 };
    group.push(position);
    return position;
  });
  for (const group of groups) for (const position of group) position.setsize = group.length;
  return out;
}

/** Terms of a filter query: separated by blanks, without case or accents (same normalization as the palette). */
export function filterTerms(query: string): string[] {
  const q = normalize(query.trim());
  return q === '' ? [] : q.split(/\s+/);
}

/** Every term is a substring of `text`; no term matches everything. */
export function matchesTerms(text: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = normalize(text);
  return terms.every((term) => haystack.includes(term));
}

/** Keeps the items that match, in their original order. Returns `items` itself when there is nothing to filter. */
export function filterItems<T>(items: readonly T[], terms: readonly string[], textOf: (item: T) => string): readonly T[] {
  return terms.length === 0 ? items : items.filter((item) => matchesTerms(textOf(item), terms));
}
