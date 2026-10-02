// Global keyboard dispatcher (03 "Keyboard"). Connected once to `window` (App.svelte).
// - a component that processes a key itself calls `preventDefault`: the dispatcher then ignores it;
// - Close escape, in order: context menu, palette, popover, dialog, graph search, central view (diff), drawer;
// - an open dialogue is modal: no other global shortcut works;
// - no single letter is global: `Mod+Z` only acts outside the entry field.
import { dialogStack } from '../dialogs/stack.svelte';
import { lifecycle } from '../lifecycle.svelte';
import { closeContextMenu } from '../menus/registry';
import { repo } from '../stores/repo.svelte';
import { graph } from '../stores/graph.svelte';
import { ui } from '../stores/ui.svelte';
import { runAction } from './registry';
import { isTextInput, listShortcuts, matchesKeys } from './shortcuts';

/** Close the first open layer (Echap). Returns `true` if something has been closed. */
export function closeTopLayer(): boolean {
  if (ui.contextMenu) {
    closeContextMenu();
    return true;
  }
  if (ui.paletteOpen) {
    ui.paletteOpen = false;
    return true;
  }
  if (ui.popover) {
    ui.closePopover();
    return true;
  }
  if (dialogStack.top) {
    dialogStack.closeTop();
    return true;
  }
  if (graph.searchOpen) {
    graph.searchOpen = false;
    return true;
  }
  if (!ui.centerIsGraph) {
    ui.closeCenter();
    return true;
  }
  if (ui.drawer) {
    ui.closeDrawer();
    return true;
  }
  return false;
}

export function handleGlobalKeydown(e: KeyboardEvent): void {
  if (lifecycle.updating) { e.preventDefault(); return; }
  if (e.defaultPrevented || e.isComposing) return;

  if (e.key === 'Escape') {
    if (closeTopLayer()) e.preventDefault();
    return;
  }

  // A dialogue is modal: neither global shortcut nor palette.
  if (dialogStack.top) return;

  if (e.key === 'Tab' && e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    repo.cycle(e.shiftKey ? -1 : 1);
    return;
  }
  const textTarget = isTextInput(e.target);
  for (const s of listShortcuts()) {
    if (!matchesKeys(e, s.keys)) continue;
    if (s.when === 'outside-text' && textTarget) continue;
    // Open palette: only its own shortcut (closure) acts.
    if (ui.paletteOpen && s.commandId !== 'palette.open') continue;
    e.preventDefault();
    void runAction(s.commandId);
    return;
  }
}
