// Colours of Canvas (03 "Themes") : `--lane-0..7`, `--bg`, `--row-selected`, `--row-hover` read by `getComputedStyle`,
// one times with each theme change (`app.themeVersion`), never in the rendering loop.

export interface Palette {
  /** 8 couleurs de lanes. */
  lanes: string[];
  bg: string;
  fgMuted: string;
  selected: string;
  hover: string;
  accent: string;
  warn: string;
}

/** Folding values (clear theme of 03) when CSS variables are not available (jsdom, tests). */
export const FALLBACK_PALETTE: Palette = {
  lanes: ['#2f6fde', '#d1242f', '#1a7f37', '#8250df', '#bf8700', '#0a7c86', '#cf2f8b', '#6e7781'],
  bg: '#ffffff',
  fgMuted: '#5c6370',
  selected: '#dbe7fd',
  hover: '#eef2f8',
  accent: '#2f6fde',
  warn: '#b7791f',
};

export function readPalette(el: Element | null = typeof document !== 'undefined' ? document.documentElement : null): Palette {
  if (!el || typeof getComputedStyle !== 'function') return FALLBACK_PALETTE;
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback;
  return {
    lanes: FALLBACK_PALETTE.lanes.map((f, i) => v(`--lane-${i}`, f)),
    bg: v('--bg', FALLBACK_PALETTE.bg),
    fgMuted: v('--fg-muted', FALLBACK_PALETTE.fgMuted),
    selected: v('--row-selected', FALLBACK_PALETTE.selected),
    hover: v('--row-hover', FALLBACK_PALETTE.hover),
    accent: v('--accent', FALLBACK_PALETTE.accent),
    warn: v('--warn', FALLBACK_PALETTE.warn),
  };
}
