import { captureStores } from '../stores/context';
import { activeSession, type Session } from '../stores/session.svelte';
import type { RepoView } from '../stores/repo.svelte';
// Register of named actions: feeds the palette, toolbar, context menus and shortcuts.
// An action = `{ id, label, enabled?, disabledReason?, run }`. A domain adds (or REMPLACE, even `id`) its actions
// From its `register.ts`. Pallet IDs are listed in 03 "Order Pallet".
import { reportError } from '../errors/report';
import type { MenuTarget } from '../menus/types';
import { app } from '../stores/app.svelte';
import { github } from '../stores/github.svelte';
import { type graph } from '../stores/graph.svelte';
import { type op } from '../stores/op.svelte';
import { type refs } from '../stores/refs.svelte';

import { type status } from '../stores/status.svelte';
import { type ui } from '../stores/ui.svelte';
import { type undo } from '../stores/undo.svelte';

/** What `enabled`, `disabledReason` and `run` receive: the stores and the potential target (contextual menus). */
export interface ActionContext {
  /** Target of the context menu that triggered the action; `undefined` from toolbar, palette or shortcut. */
  target: MenuTarget | undefined;
  repoId: number | null;
  app: typeof app;
  repo: RepoView;
  session: Session;
  graph: typeof graph;
  status: typeof status;
  refs: typeof refs;
  op: typeof op;
  undo: typeof undo;
  github: typeof github;
  ui: typeof ui;
}

export interface ActionDef {
  /** Stable identifier (`git.fetch`). Same id = replacement. */
  id: string;
  /** English wording (palette, menus, infobulles). */
  label: string | ((ctx: ActionContext) => string);
  /** False = the action is not listed in the palette (remains usable by menus and toolbar). Default: true. */
  palette?: boolean;
  /** Disabled if false (default: enabled). The disabled commands are not listed in the palette. */
  enabled?: (ctx: ActionContext) => boolean;
  /** Infobulle text when the action is disabled; not null = disabled. Rated after `enabled`. */
  disabledReason?: (ctx: ActionContext) => string | null;
  run: (ctx: ActionContext) => void | Promise<void>;
}

const actions = new Map<string, ActionDef>();

export function registerAction(def: ActionDef): () => void {
  actions.set(def.id, def);
  return () => {
    if (actions.get(def.id) === def) actions.delete(def.id);
  };
}

export function registerActions(defs: ActionDef[]): () => void {
  const offs = defs.map(registerAction);
  return () => offs.forEach((off) => off());
}

export function getAction(id: string): ActionDef | undefined {
  return actions.get(id);
}

export function listActions(): ActionDef[] {
  return [...actions.values()];
}

export function resetActions(): void {
  actions.clear();
}

export function actionContext(target?: MenuTarget, owner: Session = activeSession.current): ActionContext {
  const stores = captureStores(owner);
  return { ...stores, target, repoId: stores.repo.id, app, github };
}

export function actionLabel(def: ActionDef, ctx: ActionContext = actionContext()): string {
  return typeof def.label === 'function' ? def.label(ctx) : def.label;
}

/** Infobull text of a disabled action, `null` if enabled. `''` = disabled without explanation. */
export function actionDisabledReason(def: ActionDef, ctx: ActionContext = actionContext()): string | null {
  const reason = def.disabledReason?.(ctx) ?? null;
  if (reason) return reason;
  if (def.enabled && !def.enabled(ctx)) return '';
  return null;
}

export function isActionEnabled(def: ActionDef, ctx: ActionContext = actionContext()): boolean {
  return actionDisabledReason(def, ctx) === null;
}

/** Runs an action if it exists and is enabled. An exception is routed by `handleError` (never swallowed). */
export async function runAction(id: string, target?: MenuTarget): Promise<boolean> {
  const def = actions.get(id);
  if (!def) {
    console.warn(`[gitmini] unknown action: ${id}`);
    return false;
  }
  const ctx = actionContext(target);
  if (!isActionEnabled(def, ctx)) return false;
  try {
    await def.run(ctx);
    return true;
  } catch (e) {
    reportError(e, { command: id, repoId: ctx.repoId });
    return false;
  }
}
