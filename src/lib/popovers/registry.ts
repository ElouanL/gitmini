// A toolbar popover register (GitHub account menu...): a domain register a component (gold a lazy load,
// see lazy.svelte.ts), the toolbar opens it under the button (`ui.togglePopover(id, button)`).
// The component receives `{ close }` in props, plus those given at the opening.
import { toLazy, type Loadable, type LazyComponent } from '../lazy.svelte';

export interface PopoverProps {
  close: () => void;
}

const popovers = new Map<string, LazyComponent>();

export function registerPopover(id: string, source: Loadable): () => void {
  const entry = toLazy(source);
  popovers.set(id, entry);
  return () => {
    if (popovers.get(id) === entry) popovers.delete(id);
  };
}

export function getPopover(id: string): LazyComponent | undefined {
  return popovers.get(id);
}

export function resetPopovers(): void {
  popovers.clear();
}
