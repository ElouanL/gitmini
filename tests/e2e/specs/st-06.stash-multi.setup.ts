// ST-06: the watcher is neutralized to keep the application's stash list out of date during the external drop.
import type { SetupFn } from '../helpers';

export const setup: SetupFn = () => ({ GITMINI_WATCH_DEBOUNCE_MS: '600000' });
