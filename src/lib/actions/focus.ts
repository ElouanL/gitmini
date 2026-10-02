// Zone focus (`Mod+1` sidebar, `Mod+2` graph, `Mod+3` right panel).
// The zones of the base bear `data-zone="sidebar|graph|right"`. A domain component marks the element that should receive
// focus when you arrive in your area with `data-zone-focus` (e.g. the `wt-panel` file list).

export type FocusZone = 'sidebar' | 'graph' | 'right';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusZone(zone: FocusZone, root: ParentNode = document): boolean {
  const el = root.querySelector<HTMLElement>(`[data-zone="${zone}"]`);
  if (!el) return false;
  const target = el.querySelector<HTMLElement>('[data-zone-focus]') ?? el.querySelector<HTMLElement>(FOCUSABLE) ?? el;
  target.focus({ preventScroll: true });
  return document.activeElement === target;
}
