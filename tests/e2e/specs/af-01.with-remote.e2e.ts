// AF-01 — Auto-fetch (`fetch.auto`) and its "Pull" toast. Fixture: with-remote; the collaborator pushes 1 commit (af-01.with-remote.setup.ts).
// The interval is crossed with the clock of the test bridge (`__gitmini.autoFetch.advance`), never waited for; everything else
// is the real flow: Settings, the real backend, the toast button, the pull.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, revParse } from '../../support/git-state';
import { appReady, click, idle, isEnabled, isShown, until, waitForGone, waitForTestId } from '../../support/ui';
import { gitSpawnLines } from './flows-b-support';
import { readSettings } from './ui-support';

const MINUTE = 60_000;

interface AutoFetchState {
  fetching: number | null;
  entries: { repoId: number; failures: number; code: string | null }[];
}
interface AutoFetchBridge {
  advance(ms: number): void;
  state(): AutoFetchState;
}
type BridgeWindow = Window & { __gitmini: { autoFetch: AutoFetchBridge } };

async function advance(ms: number): Promise<void> {
  await browser.execute((n: number) => { (window as unknown as BridgeWindow).__gitmini.autoFetch.advance(n); }, ms);
}
async function autoFetchState(): Promise<AutoFetchState> {
  return browser.execute(() => (window as unknown as BridgeWindow).__gitmini.autoFetch.state());
}
async function pullToastText(): Promise<string> {
  await waitForTestId('toast-pull-btn');
  return browser.execute(() => document.querySelector('[data-testid="toast-pull-btn"]')?.closest('[data-testid="toast"]')?.textContent ?? '');
}
/** The close button of the toast that carries the Pull button (other toasts, such as an undo one, may be on screen too). */
async function closePullToast(): Promise<void> {
  await browser.execute(() => {
    document.querySelector('[data-testid="toast-pull-btn"]')?.closest('[data-testid="toast"]')?.querySelector<HTMLElement>('[data-testid="toast-close-btn"]')?.click();
  });
  await waitForGone('toast-pull-btn');
}
async function chooseInterval(minutes: number): Promise<void> {
  await click('toolbar-settings-btn');
  const select = await waitForTestId('settings-fetch-auto-select');
  await select.selectByAttribute('value', String(minutes));
  await click('settings-close-btn');
  await idle();
  await until(() => readSettings()['fetch.auto'] === minutes, { message: `fetch.auto = ${minutes} not written to settings.json` });
}

/** `git fetch --all` launches: the ones of `remote_fetch` (a pull fetches its own upstream by name). */
const fetchAllCount = (): number => gitSpawnLines().filter((l) => l.includes('"fetch"') && l.includes('"--all"')).length;

describe('AF-01 — Auto-fetch', () => {
  it('AF-01 — fetches on the chosen interval, offers Pull, stays silent when it fails and stops when switched off', async () => {
    const { repo, fx } = currentSession();
    await appReady();
    const fetches = fetchAllCount;
    const originMain = () => fx.gitIn(fx.origin, 'rev-parse', 'main');
    const base = fetches();
    const mainBefore = revParse(repo, 'main');
    expect(revParse(repo, 'origin/main')).not.toBe(originMain());

    // Off by default: a whole day goes by and gitmini never touches the network by itself.
    await advance(24 * 60 * MINUTE);
    await idle();
    expect(fetches()).toBe(base);

    // Settings → every 5 minutes. The repository has been open for a while, so the first fetch is due at once.
    await click('toolbar-settings-btn');
    expect(await (await waitForTestId('settings-fetch-auto-select')).getValue()).toBe('0');
    await click('settings-close-btn');
    await chooseInterval(5);
    await advance(MINUTE);
    expect(await pullToastText()).toContain('main is 3 commits behind origin/main.');
    await idle();
    expect(fetches()).toBe(base + 1);
    expect(revParse(repo, 'origin/main')).toBe(originMain());
    expect(revParse(repo, 'main')).toBe(mainBefore); // it fetches, it never pulls on its own
    await waitForTestId('toolbar-ahead-behind', { attrs: { behind: 3 } });
    expect(await isShown('toolbar-op-progress')).toBe(false);

    // The toast's Pull button is the toolbar's Pull.
    await click('toast-pull-btn');
    await idle();
    expect(revParse(repo, 'main')).toBe(originMain());
    await waitForGone('toast-pull-btn');

    // A fetch that brings nothing says nothing.
    await advance(5 * MINUTE + 1000);
    await until(() => fetches() === base + 2, { message: 'second automatic fetch not started' });
    await idle();
    expect(await isShown('toast-pull-btn')).toBe(false);

    // One more commit upstream: the singular, and the toast can simply be closed.
    writeFileSync(join(fx.other, 'origin4.txt'), 'origin 4\n');
    fx.gitIn(fx.other, 'add', 'origin4.txt');
    fx.gitIn(fx.other, 'commit', '-q', '-m', 'origin: add origin4.txt');
    fx.gitIn(fx.other, 'push', '-q', 'origin', 'main');
    await advance(5 * MINUTE + 1000);
    expect(await pullToastText()).toContain('main is 1 commit behind origin/main.');
    await closePullToast();
    expect(fetches()).toBe(base + 3);

    // An unreachable server: no toast, no dialog, nothing left locked; the next tries are spaced out.
    const url = git(repo, 'remote', 'get-url', 'origin');
    git(repo, 'remote', 'set-url', 'origin', 'http://127.0.0.1:1/unreachable.git');
    await advance(5 * MINUTE + 1000);
    await until(() => fetches() === base + 4, { message: 'automatic fetch against the broken remote not started' });
    await idle();
    expect(await isShown('toast[data-kind=error]')).toBe(false);
    expect(await isShown('auth-required-dialog')).toBe(false);
    expect(await isEnabled('toolbar-fetch-btn')).toBe(true);
    expect((await autoFetchState()).entries[0]).toMatchObject({ failures: 1, code: 'NETWORK' });
    await advance(5 * MINUTE + 1000); // one failure: the next try waits one interval
    await until(() => fetches() === base + 5, { message: 'retry after the first failure not started' });
    await idle();
    expect((await autoFetchState()).entries[0]).toMatchObject({ failures: 2 });
    await advance(6 * MINUTE); // two failures: ten minutes
    await idle();
    expect(fetches()).toBe(base + 5);

    // The server is back: the next try succeeds and the penalty is forgotten.
    git(repo, 'remote', 'set-url', 'origin', url);
    await advance(5 * MINUTE);
    await until(() => fetches() === base + 6, { message: 'fetch after the server came back not started' });
    await idle();
    expect((await autoFetchState()).entries[0]).toMatchObject({ failures: 0, code: null });
    await waitForGone('toast[data-kind=error]');

    // Back to never: another day passes and nothing happens.
    await chooseInterval(0);
    await advance(24 * 60 * MINUTE);
    await idle();
    expect(fetches()).toBe(base + 6);
  });
});
