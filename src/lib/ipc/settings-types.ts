// Settings: `settings_get` returns a key flat table → value (keys pointed: "sweat.mode").
// `types.ts` is generated and does not carry this type (`Settings = Record<string, unknown>` contract side).

export type ThemeSetting = 'system' | 'light' | 'dark';
export type PullModeSetting = 'ff-only' | 'rebase';
export type ProxyModeSetting = 'system' | 'none' | 'manual';
/** Minutes between two background fetches of the open repository; `0` = never. Same list as the backend (`FETCH_AUTO_MINUTES`). */
export type FetchAutoSetting = 0 | 5 | 15 | 30;
export const FETCH_AUTO_CHOICES: readonly FetchAutoSetting[] = [0, 5, 15, 30];
/** Unchanged lines shown around each change of a diff. Same list as the backend (`DIFF_CONTEXT_CHOICES`). */
export type DiffContextSetting = 1 | 3 | 5 | 10 | 25;
export const DIFF_CONTEXT_CHOICES: readonly DiffContextSetting[] = [1, 3, 5, 10, 25];
/** What `git diff` shows; the backend's default too (`CONTEXT_LINES`). */
export const DIFF_CONTEXT_DEFAULT: DiffContextSetting = 3;

/** The next larger (`delta` 1) or smaller (-1) choice, `null` at the end of the list. */
export function stepDiffContext(current: DiffContextSetting, delta: 1 | -1): DiffContextSetting | null {
  return DIFF_CONTEXT_CHOICES[DIFF_CONTEXT_CHOICES.indexOf(current) + delta] ?? null;
}

/** A `diff.contextLines` usable from what `settings.json` contains (hand-edited, or written by another version). */
export function normalizeDiffContext(raw: unknown): DiffContextSetting {
  return DIFF_CONTEXT_CHOICES.find((n) => n === raw) ?? DIFF_CONTEXT_DEFAULT;
}

/** Commands the palette lists first, most recent first. The backend only bounds the list (`PALETTE_RECENT_MAX`, 20). */
export const MAX_RECENT_COMMANDS = 8;

/** A `palette.recent` usable from what `settings.json` contains (hand-edited, or written by another version). */
export function normalizeRecentCommands(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids = raw.filter((id): id is string => typeof id === 'string' && id.length > 0);
  return [...new Set(ids)].slice(0, MAX_RECENT_COMMANDS);
}

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
  'network.proxy.mode': ProxyModeSetting;
  'network.proxy.url': string | null;
  'fetch.auto': FetchAutoSetting;
  'diff.contextLines': DiffContextSetting;
  /** Ids of the commands last run from the palette, most recent first. */
  'palette.recent': string[];
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
  'network.proxy.mode': 'system',
  'network.proxy.url': null,
  'fetch.auto': 0,
  'diff.contextLines': DIFF_CONTEXT_DEFAULT,
  'palette.recent': [],
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
