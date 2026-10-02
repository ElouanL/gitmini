// Settings: `settings_get` returns a key flat table → value (keys pointed: "sweat.mode").
// `types.ts` is generated and does not carry this type (`Settings = Record<string, unknown>` contract side).

export type ThemeSetting = 'system' | 'light' | 'dark';
export type PullModeSetting = 'ff-only' | 'rebase';

export interface LayoutSetting {
  left: number;
  right: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
}

export interface TabsSetting {
  paths: string[];
  activePath: string | null;
}

export interface KnownSettings {
  'updates.auto': boolean;
  'workspace.tabs': TabsSetting | null;
  theme: ThemeSetting;
  'pull.mode': PullModeSetting;
  'editor.command': string | null;
  'graph.dimUnreachable': boolean;
  layout: LayoutSetting;
}

export type SettingKey = keyof KnownSettings;

export type Settings = Partial<KnownSettings> & Record<string, unknown>;

export const DEFAULT_LAYOUT: LayoutSetting = { left: 240, right: 360, leftCollapsed: false, rightCollapsed: false };

export const LAYOUT_LIMITS = { left: [180, 400], right: [280, 600] } as const;

/** Default values of §5.5 (backend applies the same; front resumes them before first response). */
export const DEFAULT_SETTINGS: KnownSettings = {
  'updates.auto': true,
  'workspace.tabs': null,
  theme: 'system',
  'pull.mode': 'ff-only',
  'editor.command': null,
  'graph.dimUnreachable': true,
  layout: DEFAULT_LAYOUT,
};

const clampWidth = (v: unknown, [min, max]: readonly [number, number], fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(max, Math.max(min, v))) : fallback;

/**
 * Value of `layout` usable from what `settings.json` contains (hand-edited, or written by another version):
 * widths limited to those of the slide (left 180–400, right 280–600, 03), defect for a non-digital value, booleans
 * by default for anything that is not a Boolean. Never lift: a bench `settings.json` should not break the interface.
 */
export function normalizeLayout(raw: unknown): LayoutSetting {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    left: clampWidth(o.left, LAYOUT_LIMITS.left, DEFAULT_LAYOUT.left),
    right: clampWidth(o.right, LAYOUT_LIMITS.right, DEFAULT_LAYOUT.right),
    leftCollapsed: typeof o.leftCollapsed === 'boolean' ? o.leftCollapsed : DEFAULT_LAYOUT.leftCollapsed,
    rightCollapsed: typeof o.rightCollapsed === 'boolean' ? o.rightCollapsed : DEFAULT_LAYOUT.rightCollapsed,
  };
}

/** Missing/corrupt legacy values keep the original most-recent-repository startup. */
export function normalizeTabs(raw: unknown): TabsSetting | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.paths) || !value.paths.every((p) => typeof p === 'string' && p.length > 0)) return null;
  if (value.activePath !== null && typeof value.activePath !== 'string') return null;
  const paths = [...new Set(value.paths as string[])];
  return { paths, activePath: paths.includes(value.activePath as string) ? value.activePath as string : null };
}
