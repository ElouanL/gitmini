// Store `app`: `AppInfo` and `Settings`. The settings are from the presentation: applied immediately,
// then written by `settings_set` with a drop of 300 ms (a value refused by the backend is cancelled).
import { commands } from '../ipc/commands';
import type { AppInfo, AppError } from '../ipc/types';
import {
  DEFAULT_SETTINGS, normalizeLayout, type KnownSettings, type LayoutSetting, type SettingKey, type Settings,
  type ThemeSetting,
} from '../ipc/settings-types';
import { reportError } from '../errors/report';
import { beginActivity } from '../activity';

export const SETTINGS_DEBOUNCE_MS = 300;

export type ResolvedTheme = 'light' | 'dark';

interface PendingWrite {
  value: unknown;
  timer: ReturnType<typeof setTimeout>;
  end: () => void;
  waiters: ((e: AppError | null) => void)[];
}

function systemPrefersDark(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false; // unknown system theme: clear (03 "In error cases")
  }
}

class AppStore {
  info = $state.raw<AppInfo | null>(null);
  settings = $state.raw<Settings>({ ...DEFAULT_SETTINGS });
  /** Effectively applied theme (`system` solved); the graph repeats it with each change. */
  resolvedTheme = $state<ResolvedTheme>('light');
  /** Incremented counter with each theme change: `$effect` of the Canvas of the graph. */
  themeVersion = $state(0);
  /** Settings and `app_info` loaded: the interface can be displayed (theme and layout already applied). */
  ready = $state(false);
  /** The backend did not respond to `app_info`. */
  bootError = $state.raw<AppError | null>(null);

  #persisted: Record<string, unknown> = {};
  #pending = new Map<string, PendingWrite>();
  #mql: MediaQueryList | null = null;
  readonly #onSchemeChange = (): void => {
    if (this.theme === 'system') this.applyTheme();
  };

  // - - - Adjustments
  /** Replaces the settings with the `settings_get` response (default values for missing keys). */
  load(s: Settings): void {
    this.#persisted = { ...s };
    this.settings = { ...DEFAULT_SETTINGS, ...s, layout: normalizeLayout(s.layout) };
    this.applyTheme();
  }

  get<K extends SettingKey>(key: K): KnownSettings[K] {
    return (this.settings[key] ?? DEFAULT_SETTINGS[key]) as KnownSettings[K];
  }

  get theme(): ThemeSetting {
    return this.get('theme');
  }
  get layout(): LayoutSetting {
    return this.get('layout');
  }

  /**
   * Change a setting. Applyed immediately (`optimistic`, default), then written after 300 ms of calm.
   * Returns `null` if the write has passed, otherwise the `AppError` (`INVALID_ARGUMENT { field: "value" }`: to be displayed under the
   * field). A failure cancels the local value. `optimistic: false` (`editor.command`) only applies the value after success.
   */
  set<K extends SettingKey>(key: K, value: KnownSettings[K], opts: { optimistic?: boolean } = {}): Promise<AppError | null> {
    const optimistic = opts.optimistic ?? true;
    if (optimistic) this.#apply(key, value);
    return new Promise((resolve) => {
      const prev = this.#pending.get(key);
      let end: () => void;
      let waiters: PendingWrite['waiters'];
      if (prev) {
        clearTimeout(prev.timer);
        end = prev.end;
        waiters = prev.waiters;
      } else {
        end = beginActivity('settings');
        waiters = [];
      }
      waiters.push(resolve);
      const timer = setTimeout(() => void this.#flushKey(key, optimistic), SETTINGS_DEBOUNCE_MS);
      this.#pending.set(key, { value, timer, end, waiters });
    });
  }

  /** Writes immediately the pending settings (window closing). */
  flush(): Promise<void> {
    return Promise.all([...this.#pending.keys()].map((k) => this.#flushKey(k, true))).then(() => undefined);
  }

  async #flushKey(key: string, optimistic: boolean): Promise<void> {
    const p = this.#pending.get(key);
    if (!p) return;
    clearTimeout(p.timer);
    this.#pending.delete(key);
    let error: AppError | null = null;
    try {
      await commands.settingsSet({ key, value: p.value });
      this.#persisted[key] = p.value;
      if (!optimistic) this.#apply(key as SettingKey, p.value as never);
    } catch (e) {
      error = reportError(e, {
        command: 'settings_set',
        // A rejected value is displayed under its field (setting dialog): no toast.
        onError: (err) => err.code === 'INVALID_ARGUMENT',
      });
      // The local value is the last written value.
      if (key in this.#persisted) this.#apply(key as SettingKey, this.#persisted[key] as never);
      else this.#apply(key as SettingKey, DEFAULT_SETTINGS[key as SettingKey] as never);
    } finally {
      p.end();
      for (const w of p.waiters) w(error);
    }
  }

  #apply<K extends SettingKey>(key: K, value: KnownSettings[K]): void {
    this.settings = { ...this.settings, [key]: value };
    if (key === 'theme') this.applyTheme();
  }

  // - - Theme
  /** Sets `data-theme` on `<html>`; in `system` mode, tracks `prefers-color-scheme` live. */
  applyTheme(): void {
    const theme = this.theme;
    if (typeof document === 'undefined') return;
    if (typeof matchMedia === 'function' && !this.#mql) {
      try {
        this.#mql = matchMedia('(prefers-color-scheme: dark)');
        this.#mql.addEventListener('change', this.#onSchemeChange);
      } catch {
        this.#mql = null;
      }
    }
    const resolved: ResolvedTheme = theme === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : theme;
    const changed = this.resolvedTheme !== resolved || document.documentElement.dataset.theme !== resolved;
    this.resolvedTheme = resolved;
    document.documentElement.dataset.theme = resolved;
    if (changed) this.themeVersion++;
  }

  /** Untrace `prefers-color-scheme` (tests). */
  detachThemeListener(): void {
    this.#mql?.removeEventListener('change', this.#onSchemeChange);
    this.#mql = null;
  }

  /** Light tilt dark (palette `theme.toggle`) from the actual theme. */
  toggleTheme(): Promise<AppError | null> {
    return this.set('theme', this.resolvedTheme === 'dark' ? 'light' : 'dark');
  }

  get gitError(): AppInfo['gitError'] {
    return this.info?.gitError ?? null;
  }
  get e2e(): boolean {
    return this.info?.e2e ?? false;
  }
}

export const app = new AppStore();

