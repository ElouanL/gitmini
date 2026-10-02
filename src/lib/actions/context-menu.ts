// Action Svelte : `<div use:contextMenu={ => ({ menu: 'branch', branch })}>` opens the context menu with right click,
// and on the keyboard by `Shift+F10` or the Menu key (03 "Context Menus"). Return `null` to open nothing.
import { openContextMenu } from '../menus/registry';
import type { MenuTarget } from '../menus/types';

type Getter = () => MenuTarget | null | undefined;

export function contextMenu(node: HTMLElement, getTarget: Getter) {
  let get = getTarget;

  const onContext = (e: MouseEvent) => {
    const target = get();
    if (!target) return;
    e.preventDefault();
    e.stopPropagation(); // an embedded menu (line in a list) does not reopen the parent's menu
    openContextMenu(target, e.clientX, e.clientY, null);
  };

  const onKey = (e: KeyboardEvent) => {
    if (!((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu')) return;
    const target = get();
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    const r = node.getBoundingClientRect();
    openContextMenu(target, r.left + Math.min(24, r.width / 2), r.bottom, node);
  };

  node.addEventListener('contextmenu', onContext);
  node.addEventListener('keydown', onKey);
  return {
    update(next: Getter) {
      get = next;
    },
    destroy() {
      node.removeEventListener('contextmenu', onContext);
      node.removeEventListener('keydown', onKey);
    },
  };
}
