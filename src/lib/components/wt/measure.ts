// Svelte action: visible height of a container (virtualization). `ResizeObserver` when it exists, otherwise a single reading
// (jsdom). No layout reading in the rendering: only here, at creation and every resize.
export function measureHeight(node: HTMLElement, onheight: (h: number) => void) {
  let cb = onheight;
  const read = () => cb(node.clientHeight);
  read();
  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(read);
    ro.observe(node);
  }
  return {
    update(next: (h: number) => void) {
      cb = next;
      read();
    },
    destroy() {
      ro?.disconnect();
    },
  };
}
