// Context menu register: `context-menu[data-menu=…]`, `context-menu-item-<action>` entries (closed list of ).
// A domain adds its entries by `registerMenuItems(menuId, items)`; an entry of the same `id` in the same REMPLACE menu
// the previous one. The non-applicable entries are hidden (`visible`), not grayed; the destructive ones are at the bottom, in red.
import { actionContext, actionDisabledReason, actionLabel, getAction, type ActionContext } from '../actions/registry';
import { reportError } from '../errors/report';
import { ui } from '../stores/ui.svelte';
import { t } from '../../i18n/index';
import type { MenuId, MenuItemId, MenuTarget, MenuTargetOf } from './types';

export interface MenuItemDef<M extends MenuId = MenuId> {
  /** Suffix of the `data-testid`: `context-menu-item-<id>`. */
  id: MenuItemId;
  /** Wording; default: that of the linked action, if not `menu.item.<id>` in i18n. */
  label?: string | ((ctx: ActionContext & { target: MenuTargetOf<M> }) => string);
  /** Action of the executed registry (its `enabled`/`disabledReason` also applies). */
  action?: string;
  /** Direct execution, if no `action`. */
  run?: (ctx: ActionContext & { target: MenuTargetOf<M> }) => void | Promise<void>;
  /** False = masked. Default: visible. */
  visible?: (ctx: ActionContext & { target: MenuTargetOf<M> }) => boolean;
  /** False = shaded (transitional state, e.g. flight operation). */
  enabled?: (ctx: ActionContext & { target: MenuTargetOf<M> }) => boolean;
  /** Destructive action: below, separated by a line, in red. */
  danger?: boolean;
  /** Display order (default 100, crescent). */
  order?: number;
}

export interface ResolvedMenuItem {
  id: MenuItemId;
  label: string;
  disabled: boolean;
  danger: boolean;
  separatorBefore: boolean;
  run: () => Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const menus = new Map<MenuId, MenuItemDef<any>[]>();

export function registerMenuItems<M extends MenuId>(menu: M, items: MenuItemDef<M>[]): () => void {
  const list = [...(menus.get(menu) ?? [])];
  for (const it of items) {
    const i = list.findIndex((x) => x.id === it.id);
    if (i >= 0) list[i] = it;
    else list.push(it);
  }
  menus.set(menu, list);
  return () => {
    menus.set(menu, (menus.get(menu) ?? []).filter((x) => !items.includes(x)));
  };
}

export function menuItemIds(menu: MenuId): string[] {
  return (menus.get(menu) ?? []).map((i) => i.id);
}

export function resetMenus(): void {
  menus.clear();
}

/** Visible entries from a menu for a target, ordered (destructive at the bottom). */
export function resolveMenu(target: MenuTarget): ResolvedMenuItem[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = actionContext(target) as ActionContext & { target: any };
  const defs = [...(menus.get(target.menu) ?? [])];
  const visible = defs.filter((d) => (d.visible ? d.visible(ctx) : true));
  const ordered = visible
    .map((d, i) => ({ d, i }))
    .sort((a, b) => Number(!!a.d.danger) - Number(!!b.d.danger) || (a.d.order ?? 100) - (b.d.order ?? 100) || a.i - b.i)
    .map((x) => x.d);
  let seenDanger = false;
  return ordered.map((d) => {
    const action = d.action ? getAction(d.action) : undefined;
    const label = d.label
      ? typeof d.label === 'function' ? d.label(ctx) : d.label
      : action ? actionLabel(action, ctx) : t(`menu.item.${d.id}`);
    const actionBlocked = action ? actionDisabledReason(action, ctx) !== null : false;
    const disabled = actionBlocked || (d.enabled ? !d.enabled(ctx) : false) || (!action && !d.run);
    const separatorBefore = !!d.danger && !seenDanger;
    if (d.danger) seenDanger = true;
    return {
      id: d.id, label, disabled, danger: !!d.danger, separatorBefore,
      run: async () => {
        try {
          if (action) await action.run(ctx);
          else await d.run?.(ctx);
        } catch (e) {
          reportError(e, { command: d.action ?? `menu:${d.id}` });
        }
      },
    };
  });
}

/** Opens the context menu of `target` to (x, y). Without visible input: nothing. `returnFocus`: element re-consolidated when closed. */
export function openContextMenu(target: MenuTarget, x: number, y: number, returnFocus: HTMLElement | null = null): boolean {
  if (resolveMenu(target).length === 0) return false;
  ui.contextMenu = { target, x, y, returnFocus };
  return true;
}

export function closeContextMenu(): void {
  const m = ui.contextMenu;
  ui.contextMenu = null;
  m?.returnFocus?.focus();
}
