// What the palette lists, as sections of items: commands, then (behind `@`, `#`, `/`) branches and tags, commits and
// repositories. Pure functions of plain data, so each can be tested without a repository; `Palette.svelte` feeds them
// from the stores and runs the item the user picks.
import { t, tp } from '../../i18n/index';
import type { CheckoutTarget } from '../ipc/commands';
import type { GraphRow, LogPage, RecentRepo, RefsSnapshot } from '../ipc/types';
import type { Session } from '../stores/session.svelte';
import { fold, rank } from './fuzzy';
import { filterCommands, recentEntries, type PaletteEntry } from './palette';

/** Longest list drawn: a repository can hold thousands of tags, and nobody scrolls through them to pick one. */
export const MAX_ITEMS = 100;
/** Commits listed while nothing is typed after `#`: the newest ones the graph has loaded. */
export const RECENT_COMMITS = 30;

interface ItemBase {
  /** Unique within the list. */
  key: string;
  label: string;
  /** Positions of `label` to highlight. */
  match: readonly number[];
  /** Muted text after the label (a short sha, a path). */
  detail: string | null;
  /** Small tag at the end of the row (`branch`, `tag`, `current`...). */
  badge: string | null;
  /** Tooltip with what `detail` shortens (the whole path, the whole sha). */
  title: string | null;
  /** The item stands for what is already current (the checked-out branch, the active tab). */
  current: boolean;
}

export interface CommandItem extends ItemBase {
  kind: 'command';
  id: string;
}

export interface RefItem extends ItemBase {
  kind: 'ref';
  refKind: 'local' | 'remote' | 'tag';
  /** The commit the graph jumps to. */
  oid: string;
  /** What `Mod+Enter` checks out; `null` when nothing can be (current branch, a write is in flight). */
  checkout: CheckoutTarget | null;
}

export interface CommitItem extends ItemBase {
  kind: 'commit';
  oid: string;
}

export interface RepoItem extends ItemBase {
  kind: 'repo';
  path: string;
  /** The open tab, or `null` for a recent repository that is not open. */
  tab: Session | null;
}

export type PaletteItem = CommandItem | RefItem | CommitItem | RepoItem;

export interface PaletteSection {
  id: string;
  /** Heading of the group; `null` for a single ranked list. */
  label: string | null;
  items: PaletteItem[];
}

/** The list as drawn: headings and items in order, each item knowing its position among the items. */
export type PaletteRow =
  | { type: 'header'; key: string; label: string }
  | { type: 'item'; key: string; item: PaletteItem; index: number };

export function toRows(sections: readonly PaletteSection[]): PaletteRow[] {
  const rows: PaletteRow[] = [];
  let index = 0;
  for (const section of sections) {
    if (section.items.length === 0) continue;
    if (section.label) rows.push({ type: 'header', key: `section:${section.id}`, label: section.label });
    for (const item of section.items) rows.push({ type: 'item', key: item.key, item, index: index++ });
  }
  return rows;
}

export function itemsOf(sections: readonly PaletteSection[]): PaletteItem[] {
  return sections.flatMap((s) => s.items);
}

const base = (key: string, label: string, over: Partial<ItemBase> = {}): ItemBase => ({
  key, label, match: [], detail: null, badge: null, title: null, current: false, ...over,
});

// ── Commands

const commandItem = (e: PaletteEntry): CommandItem => ({ ...base(`command:${e.id}`, e.label, { match: e.match ?? [] }), kind: 'command', id: e.id });

/**
 * Nothing typed: the commands run last come first, under their own heading, and are not repeated below.
 * Typed text: one list ranked by `filterCommands`.
 */
export function commandSections(entries: PaletteEntry[], term: string, recent: readonly string[]): PaletteSection[] {
  if (term) return [{ id: 'commands', label: null, items: filterCommands(entries, term, recent).map(commandItem) }];
  const used = recentEntries(entries, recent);
  if (used.length === 0) return [{ id: 'commands', label: null, items: entries.map(commandItem) }];
  const usedIds = new Set(used.map((e) => e.id));
  return [
    { id: 'recent', label: t('palette.section.recent'), items: used.map(commandItem) },
    { id: 'commands', label: t('palette.section.commands'), items: entries.filter((e) => !usedIds.has(e.id)).map(commandItem) },
  ];
}

// ── Branches and tags

interface RefChoice {
  refKind: RefItem['refKind'];
  /** What the user knows it by: `feature/login`, `origin/main`, `v1.0`. */
  name: string;
  oid: string;
  current: boolean;
  checkout: CheckoutTarget | null;
}

function refChoices(snapshot: RefsSnapshot, canCheckout: boolean): RefChoice[] {
  const checkout = (target: CheckoutTarget): CheckoutTarget | null => (canCheckout ? target : null);
  return [
    ...snapshot.local.map((b): RefChoice => ({
      refKind: 'local', name: b.name, oid: b.oid, current: b.isHead,
      checkout: b.isHead ? null : checkout({ kind: 'local', name: b.name }),
    })),
    ...snapshot.remote.map((b): RefChoice => ({
      refKind: 'remote', name: `${b.remote}/${b.name}`, oid: b.oid, current: false,
      checkout: checkout({ kind: 'remote', ref: `${b.remote}/${b.name}` }),
    })),
    // A tag opens on the commit it points to (an annotated tag has an object of its own).
    ...snapshot.tags.map((tag): RefChoice => ({
      refKind: 'tag', name: tag.name, oid: tag.targetOid, current: false,
      checkout: checkout({ kind: 'detached', oid: tag.targetOid }),
    })),
  ];
}

const REF_BADGE = { local: 'palette.kind.branch', remote: 'palette.kind.remote', tag: 'palette.kind.tag' } as const;
const REF_SECTION = { local: 'palette.section.branches', remote: 'palette.section.remotes', tag: 'palette.section.tags' } as const;

function refItem(c: RefChoice, match: readonly number[] = []): RefItem {
  return {
    ...base(`${c.refKind}:${c.name}`, c.name, { match, badge: c.current ? t('palette.kind.current') : t(REF_BADGE[c.refKind]), current: c.current }),
    kind: 'ref', refKind: c.refKind, oid: c.oid, checkout: c.checkout,
  };
}

/**
 * `@`: local branches, remote branches and tags. Nothing typed: grouped, in the backend's order (current branch first).
 * Typed text: one list ranked by fuzzy match on the name.
 */
export function refSections(snapshot: RefsSnapshot | null, term: string, canCheckout: boolean): PaletteSection[] {
  if (!snapshot) return [];
  const choices = refChoices(snapshot, canCheckout);
  if (term) {
    const ranked = rank(choices, term, (c) => c.name).slice(0, MAX_ITEMS);
    return [{ id: 'refs', label: null, items: ranked.map((r) => refItem(r.item, r.indices)) }];
  }
  let budget = MAX_ITEMS;
  return (['local', 'remote', 'tag'] as const).map((kind) => {
    const items = choices.filter((c) => c.refKind === kind).slice(0, budget).map((c) => refItem(c));
    budget -= items.length;
    return { id: kind, label: t(REF_SECTION[kind]), items };
  });
}

// ── Commits

export interface CommitChoice {
  oid: string;
  summary: string;
  /** Names of the branches and tags on it. */
  refs: string[];
}

export function commitChoice(row: GraphRow): CommitChoice {
  return { oid: row.oid, summary: row.summary, refs: row.refs.map((r) => r.name) };
}

/** The newest commits among the pages the graph has loaded (stash rows are not commits to go to). */
export function loadedCommits(pages: readonly LogPage[], limit = RECENT_COMMITS): CommitChoice[] {
  const seen = new Set<string>();
  const out: CommitChoice[] = [];
  for (const page of pages) {
    for (const row of page.rows) {
      if (row.kind !== 'commit' || seen.has(row.oid)) continue;
      seen.add(row.oid);
      out.push(commitChoice(row));
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Positions of the first occurrence of `term` in `text`, ignoring case and accents; none when it does not occur. */
export function occurrence(term: string, text: string): number[] {
  const needle = fold(term.trim());
  const at = needle ? fold(text).indexOf(needle) : -1;
  return at < 0 ? [] : Array.from({ length: needle.length }, (_, i) => at + i);
}

const shortOid = (oid: string): string => oid.slice(0, 7);

const PATH_MAX = 44;

/** A long path cut at the front, since the end (the repository and its parent) is what tells them apart. */
export function compactPath(path: string, max = PATH_MAX): string {
  if (path.length <= max) return path;
  const tail = path.slice(-(max - 1));
  const cut = tail.search(/[\\/]/);
  // Start at a folder boundary when that costs little.
  return `…${cut > 0 && cut < tail.length - 8 ? tail.slice(cut) : tail}`;
}

function commitItem(c: CommitChoice, term: string): CommitItem {
  const extra = c.refs.length - 2;
  const badge = c.refs.length ? c.refs.slice(0, 2).join(', ') + (extra > 0 ? ` +${extra}` : '') : null;
  return { ...base(`commit:${c.oid}`, c.summary || t('palette.noSubject'), { match: occurrence(term, c.summary), detail: shortOid(c.oid), badge, title: c.oid }), kind: 'commit', oid: c.oid };
}

/** `#`: `choices` are the loaded commits (nothing typed) or what the search found, already in graph order. */
export function commitSections(choices: readonly CommitChoice[], term: string): PaletteSection[] {
  return [{ id: 'commits', label: term ? null : t('palette.section.commits'), items: choices.slice(0, MAX_ITEMS).map((c) => commitItem(c, term)) }];
}

// ── Repositories

const samePath = (a: string, b: string): boolean => a.replace(/[\\/]+$/, '') === b.replace(/[\\/]+$/, '');

export interface OpenTab {
  session: Session;
  name: string;
  path: string;
}

/** `/`: the open tabs (in tab order), then the recent repositories that are not open. Typed text: one ranked list. */
export function repoSections(tabs: readonly OpenTab[], active: Session | null, recents: readonly RecentRepo[], term: string): PaletteSection[] {
  const open = tabs.map((tab): RepoItem => ({
    ...base(`tab:${tab.path}`, tab.name, { detail: compactPath(tab.path), title: tab.path, badge: tab.session === active ? t('palette.kind.current') : t('palette.kind.open'), current: tab.session === active }),
    kind: 'repo', path: tab.path, tab: tab.session,
  }));
  const closed = recents
    .filter((r) => !tabs.some((tab) => samePath(tab.path, r.path)))
    .map((r): RepoItem => ({ ...base(`recent:${r.path}`, r.name, { detail: compactPath(r.path), title: r.path }), kind: 'repo', path: r.path, tab: null }));
  if (!term) {
    return [
      { id: 'tabs', label: t('palette.section.tabs'), items: open },
      { id: 'recent-repos', label: t('palette.section.recentRepos'), items: closed },
    ];
  }
  // The name is what the user remembers, matched loosely. The path only has to contain the text: it tells two
  // checkouts of the same name apart, and a loose match on a long path would match nearly anything.
  const items = [...open, ...closed].flatMap((item) => {
    const byName = rank([item], term, (i) => i.label)[0];
    if (byName) return [{ item: { ...item, match: byName.indices }, score: byName.score }];
    return occurrence(term, item.path).length > 0 ? [{ item, score: -1 }] : [];
  });
  return [{ id: 'repos', label: null, items: items.sort((a, b) => b.score - a.score).map((r) => r.item) }];
}

// ── Messages

/** "3 results", for a screen reader. */
export function resultsStatus(n: number): string {
  return n === 0 ? t('palette.status.none') : tp('palette.status', n);
}
