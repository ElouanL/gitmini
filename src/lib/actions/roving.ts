// Action Svelte "Roving tabindex": only one item in the list is in the tab order; ↑/▼, Start, End move the focus.
//   <div use:roving={'[data-roving]'}> … <button data-roving>…</button> … </div>
// The container also manages `Mod+1/2/3` via `data-zone` (see focus.ts: the element bearing `tabindex=0` receives the zone focus).
export function roving(node: HTMLElement, selector: string) {
  let sel = selector;
  const items = (): HTMLElement[] => [...node.querySelectorAll<HTMLElement>(sel)].filter((el) => !el.hasAttribute('disabled') && !el.hidden);

  const sync = (active?: HTMLElement | null): void => {
    const list = [...node.querySelectorAll<HTMLElement>(sel)];
    const current = active ?? list.find((el) => el.getAttribute('tabindex') === '0') ?? list[0] ?? null;
    for (const el of list) el.setAttribute('tabindex', el === current ? '0' : '-1');
  };

  const onFocusIn = (e: FocusEvent): void => {
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>(sel);
    if (el && node.contains(el)) sync(el);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const list = items();
    if (list.length === 0) return;
    const i = list.indexOf((e.target as HTMLElement).closest<HTMLElement>(sel) as HTMLElement);
    if (i < 0) return;
    let next = -1;
    if (e.key === 'ArrowDown') next = Math.min(list.length - 1, i + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, i - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else if (e.key === 'PageDown') next = Math.min(list.length - 1, i + 10);
    else if (e.key === 'PageUp') next = Math.max(0, i - 10);
    if (next < 0) return;
    e.preventDefault();
    list[next]!.focus();
    list[next]!.scrollIntoView?.({ block: 'nearest' });
  };

  const observer = new MutationObserver(() => sync());
  observer.observe(node, { childList: true, subtree: true });
  node.addEventListener('focusin', onFocusIn);
  node.addEventListener('keydown', onKeyDown);
  sync();

  return {
    update(next: string) {
      sel = next;
      sync();
    },
    destroy() {
      observer.disconnect();
      node.removeEventListener('focusin', onFocusIn);
      node.removeEventListener('keydown', onKeyDown);
    },
  };
}
