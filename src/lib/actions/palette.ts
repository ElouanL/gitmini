// Pure logic of the palette: list of available commands and sub-chain filter without breakage or accents (03 "Palette").
import { actionContext, actionLabel, isActionEnabled, listActions, type ActionContext, type ActionDef } from './registry';

export interface PaletteEntry {
  id: string;
  label: string;
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

export function filterCommands(entries: PaletteEntry[], query: string): PaletteEntry[] {
  const q = normalize(query.trim());
  if (!q) return entries;
  return entries.filter((e) => normalize(e.label).includes(q) || normalize(e.id).includes(q));
}
