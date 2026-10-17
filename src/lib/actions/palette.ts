// Pure logic of the palette (03 "Palette"): the commands it lists, how a typed text is read (commands, or an entity
// behind a prefix), the fuzzy ranking and the commands run last. What each entity looks like is in `palette-entities.ts`.
import { MAX_RECENT_COMMANDS } from '../ipc/settings-types';
import { fold, fuzzyMatch } from './fuzzy';
import { actionContext, actionLabel, isActionEnabled, listActions, type ActionContext, type ActionDef } from './registry';

export interface PaletteEntry {
  id: string;
  label: string;
  /** Positions of `label` the typed text matched, for highlighting. */
  match?: readonly number[];
}

export function normalize(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Listable commands: `palette !== false` and enabled (deactivated commands are not listed). */
export function availableCommands(ctx: ActionContext = actionContext()): PaletteEntry[] {
  return listActions()
    .filter((a: ActionDef) => a.palette !== false && isActionEnabled(a, ctx))
    .map((a) => ({ id: a.id, label: actionLabel(a, ctx) }));
}

// ── What is typed

/** What the palette searches: the commands, or (behind `@`, `#`, `/`) branches and tags, commits, repositories. */
export type PaletteMode = 'commands' | 'refs' | 'commits' | 'repos';

export const MODE_PREFIX = { refs: '@', commits: '#', repos: '/' } as const;

export interface PaletteQuery {
  mode: PaletteMode;
  /** The text to look for, without the prefix. */
  term: string;
}

/** `@feat` → branches and tags matching "feat"; `#fix typo` → commits; `/api` → repositories; anything else → commands. */
export function parseQuery(raw: string): PaletteQuery {
  const text = raw.trimStart();
  for (const mode of ['refs', 'commits', 'repos'] as const) {
    if (text.startsWith(MODE_PREFIX[mode])) return { mode, term: text.slice(1).trim() };
  }
  return { mode: 'commands', term: text.trim() };
}

// ── Commands

/** Score of a command matched on its id only (`git.fetch`), always below a match on its label. */
const ID_ONLY = 5;

/**
 * Commands matching `query`, best first: every word of the query must appear, in order, in the label (or, failing that,
 * in the id). A command run recently ranks above an equal match. Empty query: the entries, untouched.
 */
export function filterCommands(entries: PaletteEntry[], query: string, recent: readonly string[] = []): PaletteEntry[] {
  const q = query.trim();
  if (!q) return entries;
  const words = fold(q).split(/\s+/);
  const ranked: { entry: PaletteEntry; score: number }[] = [];
  for (const entry of entries) {
    const rank = recent.indexOf(entry.id);
    const boost = rank < 0 ? 0 : MAX_RECENT_COMMANDS - rank;
    const found = fuzzyMatch(q, entry.label);
    if (found) ranked.push({ entry: { ...entry, match: found.indices }, score: found.score + boost });
    else if (words.every((w) => fold(entry.id).includes(w))) ranked.push({ entry, score: ID_ONLY + boost });
  }
  return ranked.sort((a, b) => b.score - a.score).map((r) => r.entry);
}

// ── Recent commands

/** `id` first, the rest after it in their order, at most `max`. */
export function pushRecent(list: readonly string[], id: string, max = MAX_RECENT_COMMANDS): string[] {
  return [id, ...list.filter((x) => x !== id)].slice(0, max);
}

/** The recent commands that are listable now, most recent first. */
export function recentEntries(entries: readonly PaletteEntry[], recent: readonly string[]): PaletteEntry[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  return recent.flatMap((id) => byId.get(id) ?? []);
}
