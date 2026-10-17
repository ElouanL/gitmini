// `settings.json` of the application (recent repositories, tabs...). Setups write it before the bridge starts; specs read it
// back through `repo.readSettings()`. Standalone module so that a `*.setup.ts` can import it without loading Playwright.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Content of a settings file (empty object if it does not exist yet or is not valid JSON). */
export function readSettingsFile(settingsPath: string): Record<string, unknown> {
  if (!existsSync(settingsPath)) return {};
  try {
    return JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Writes `settings.json` before launch (recent repositories, workspace tabs...): call it from a setup. */
export function writeSettings(settingsPath: string, settings: Record<string, unknown>): void {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

/** Entry of the `recent` list as the backend stores it. */
export function recentEntry(path: string, name: string): { path: string; name: string; lastOpened: string } {
  return { path, name, lastOpened: '2026-09-01T10:00:00Z' };
}
