// STAGE-08: the watcher is neutralized: the application does not see the external change before the click.
import type { SetupFn } from '../helpers';

export const setup: SetupFn = () => ({ GITMINI_WATCH_DEBOUNCE_MS: '600000' });
