// The palette as a user drives it: commands with the ones run last first, and branches (`@`), commits (`#`) and
// repositories (`/`) behind a prefix. Real stores and components over a fake transport.
// Booting the whole application costs most of a test's time, so each test walks through several steps of one session.
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import App from '../../../App.svelte';
import { whenIdle } from '../../activity';
import { bootstrap } from '../../bootstrap';
import type { LogPage } from '../../ipc/types';
import { app } from '../../stores/app.svelte';
import { graph } from '../../stores/graph.svelte';
import { op } from '../../stores/op.svelte';
import { repo } from '../../stores/repo.svelte';
import { activeSession } from '../../stores/session.svelte';
import { ui } from '../../stores/ui.svelte';
import { unwireEvents } from '../../stores/wiring';
import { createFakeTransport, type FakeTransport, type Handler } from '../../test/fake-transport';
import {
  makeAppInfo, makeLogPage, makeRecents, makeRefs, makeRemotes, makeRepoInfo, makeStashes, makeStatus, makeUndo, oid,
} from '../../test/fixtures';
import { resetAll } from '../../test/reset';
import '../../register-core';
import '../../register-domains';

let fake: FakeTransport;

const SECOND = '/Users/demo/dev/api-server';

/** A commit the graph has not loaded: only a `startRow` read or an `aroundOid` read can bring it. */
const FAR = oid(900);

function farPage(): LogPage {
  const page = makeLogPage(60, 60);
  const row = { ...page.rows[3]!, oid: FAR, summary: 'fix: a login crash from long ago', refs: [] };
  return { ...page, rows: [row], start: 700 };
}

async function openShell(over: Record<string, Handler> = {}, opts: { repo?: boolean; settings?: Record<string, unknown> } = {}) {
  const withRepo = opts.repo ?? true;
  fake = createFakeTransport({
    app_info: () => makeAppInfo({ initialPath: withRepo ? '/r' : null }), settings_set: () => null,
    // A saved, empty workspace keeps the most recent repository from being reopened at startup.
    settings_get: () => ({ ...(withRepo ? {} : { 'workspace.tabs': { paths: [], activePath: null } }), ...opts.settings }),
    repo_recent_list: () => makeRecents(),
    repo_open: (a: Record<string, unknown>) => (a.path === SECOND ? makeRepoInfo({ id: 2, workdir: SECOND, name: 'api-server' }) : makeRepoInfo()),
    repo_close: () => null,
    log_page: (a: Record<string, unknown>) => (a.startRow === 700 ? farPage() : a.aroundOid === FAR ? { ...farPage(), start: 0 } : makeLogPage()),
    refs_list: () => makeRefs(), remote_list: () => makeRemotes(),
    stash_list: () => makeStashes(), status_get: () => makeStatus(), undo_peek: () => makeUndo(), github_status: () => ({ loggedIn: false, login: null }),
    ...over,
  }).install();
  render(App);
  await bootstrap();
  if (withRepo) await screen.findByTestId('toolbar-repo-name');
  await whenIdle();
}

/** Opens the palette and types `text`; resolves with the input. */
async function palette(text = ''): Promise<HTMLElement> {
  ui.paletteOpen = true;
  const input = await screen.findByTestId('palette-input');
  await waitFor(() => expect(document.activeElement).toBe(input));
  if (text) await userEvent.type(input, text);
  return input;
}

async function closePalette(): Promise<void> {
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByTestId('palette')).toBeNull());
}

const items = () => screen.queryAllByTestId('palette-item');
const labelsOf = () => items().map((i) => i.dataset.label);
const idsOf = () => items().map((i) => i.dataset.commandId);
const headings = () => screen.queryAllByTestId('palette-section').map((e) => e.textContent);
const marks = (item: HTMLElement) => [...item.querySelectorAll('mark')].map((m) => m.textContent).join('');
const ctrlEnter = () => userEvent.keyboard('{Control>}{Enter}{/Control}');
const savedRecent = () => fake.callsOf('settings_set').filter((c) => c.args.key === 'palette.recent').map((c) => c.args.value);

beforeEach(() => resetAll({ keepRegistrations: true }));
afterEach(() => unwireEvents());

describe('palette: commands you ran lately', () => {
  it("a command run from the palette is saved and listed first, once, the next time, most recent first", async () => {
    await openShell();
    await palette();
    expect(headings()).toEqual([]); // nothing run yet: no heading
    await userEvent.type(screen.getByTestId('palette-input'), 'theme');
    expect(idsOf()).toEqual(['theme.toggle']);
    await userEvent.keyboard('{Enter}');
    await whenIdle();
    expect(savedRecent()).toEqual([['theme.toggle']]);

    await palette();
    expect(headings()).toEqual(['Recently used', 'All commands']);
    expect(idsOf()[0]).toBe('theme.toggle');
    expect(idsOf().filter((id) => id === 'theme.toggle')).toHaveLength(1); // not repeated below
    expect(items()[0]).toHaveAttribute('aria-selected', 'true'); // Enter right away repeats it
    await closePalette();

    for (const text of ['fetch', 'theme', 'fetch']) {
      await palette(text);
      await userEvent.keyboard('{Enter}');
      await whenIdle();
    }
    expect(savedRecent().at(-1)).toEqual(['git.fetch', 'theme.toggle']);
    await palette();
    expect(idsOf().slice(0, 2)).toEqual(['git.fetch', 'theme.toggle']);
  });

  it("starts from what the settings file holds and keeps the last eight", async () => {
    await openShell({}, { settings: { 'palette.recent': ['undo.last', 'gone.away', ...Array.from({ length: 10 }, (_, i) => `cmd.${i}`)] } });
    expect(app.get('palette.recent')).toHaveLength(12); // as stored; the palette only reads eight
    await palette();
    expect(headings()).toEqual(['Recently used', 'All commands']);
    expect(idsOf()[0]).toBe('undo.last'); // an id that is no command is just left out
    await userEvent.type(screen.getByTestId('palette-input'), 'theme');
    await userEvent.keyboard('{Enter}');
    await whenIdle();
    const saved = savedRecent().at(-1) as string[];
    expect(saved).toHaveLength(8);
    expect(saved.slice(0, 2)).toEqual(['theme.toggle', 'undo.last']);
  });

  it("ignores a bad saved value; typed text is ranked by fuzzy match with the letters marked, selection back on the best", async () => {
    await openShell({}, { settings: { 'palette.recent': 'oops' } });
    const input = await palette();
    expect(headings()).toEqual([]);
    expect(items().length).toBeGreaterThan(5);
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(items()[2]).toHaveAttribute('aria-selected', 'true');

    await userEvent.type(input, 'pll');
    expect(labelsOf()[0]).toBe('Pull');
    expect(labelsOf().length).toBeGreaterThan(1);
    expect(marks(items()[0]!)).toBe('Pll');
    expect(items()[0]).toHaveAttribute('aria-selected', 'true'); // typing puts the selection back on the best match
    expect(input).toHaveAttribute('aria-activedescendant', items()[0]!.id);
  });
});

describe('palette: branches and tags (@)', () => {
  it("lists every ref under headings, narrows by fuzzy match, and Enter shows the commit in the graph without checking out", async () => {
    await openShell();
    await palette('@');
    expect(screen.getByTestId('palette')).toHaveAttribute('data-mode', 'refs');
    expect(headings()).toEqual(['Branches', 'Remote branches', 'Tags']);
    expect(labelsOf()).toEqual(['main', 'feature/login', 'fix/typo', 'topic', 'origin/main', 'origin/feature/login', 'v0.1.0', 'v0.2.0']);
    expect(items()[0]).toHaveAttribute('data-current', 'true');
    expect(within(items()[0]!).getByTestId('palette-item-badge')).toHaveTextContent('current');
    expect(screen.getByTestId('palette-hint')).toHaveTextContent('Enter to show in the graph');
    await userEvent.type(screen.getByTestId('palette-input'), 'flogin');
    expect(labelsOf()).toEqual(['feature/login', 'origin/feature/login']);
    await userEvent.keyboard('{Enter}');
    expect(screen.queryByTestId('palette')).toBeNull();
    await waitFor(() => expect(graph.selection).toEqual({ kind: 'commits', oids: [oid(55)], anchor: oid(55) }));

    // A tag shows the commit it points to (v0.2.0 is annotated: its own object is another).
    await palette('@v0.2');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(graph.selection).toMatchObject({ oids: [oid(40)] }));

    // A diff open in the centre gives way: the graph comes back to show the commit. Clicking jumps like Enter.
    ui.openCenter('diff', { path: 'a.txt', source: { kind: 'unstaged' } });
    await palette('@topic');
    await userEvent.click(items()[0]!);
    expect(ui.centerIsGraph).toBe(true);
    await waitFor(() => expect(graph.selection).toMatchObject({ oids: [oid(30)] }));
    expect(fake.callsOf('branch_checkout')).toHaveLength(0); // jumping never changes the checkout

    // Nothing matches: a message, and Enter does nothing.
    await palette('@zzzz');
    expect(items()).toHaveLength(0);
    expect(screen.getByTestId('palette-empty')).toHaveTextContent('No branch or tag matches');
    await userEvent.keyboard('{Enter}');
    expect(screen.getByTestId('palette')).toBeInTheDocument();
  });

  it("Mod+Enter checks out a branch, a remote branch or a tag; not the current branch, not while an operation runs", async () => {
    await openShell({ branch_checkout: () => makeRefs() });
    await palette('@fix/typo');
    expect(screen.getByTestId('palette-hint')).toHaveTextContent(/to check out/);
    await ctrlEnter();
    expect(screen.queryByTestId('palette')).toBeNull();
    await whenIdle();
    expect(graph.selection.kind).not.toBe('commits'); // checked out, not jumped to

    await palette('@origin/feature');
    await ctrlEnter();
    await whenIdle();
    await palette('@v0.1');
    await ctrlEnter();
    await whenIdle();
    expect(fake.callsOf('branch_checkout').map((c) => c.args)).toEqual([
      { repoId: 1, target: { kind: 'local', name: 'fix/typo' } },
      { repoId: 1, target: { kind: 'remote', ref: 'origin/feature/login' } },
      { repoId: 1, target: { kind: 'detached', oid: oid(20) } },
    ]);

    // Nothing to check out on the current branch: the palette stays open and the hint does not offer it.
    await palette('@main');
    expect(labelsOf()[0]).toBe('main');
    expect(screen.getByTestId('palette-hint')).not.toHaveTextContent(/to check out/);
    await ctrlEnter();
    expect(screen.getByTestId('palette')).toBeInTheDocument();
    expect(fake.callsOf('branch_checkout')).toHaveLength(3);
    await closePalette();

    // While an operation is running no checkout is offered, but jumping still works.
    const end = op.begin('Pull');
    await palette('@fix/typo');
    expect(screen.getByTestId('palette-hint')).not.toHaveTextContent(/to check out/);
    await ctrlEnter();
    expect(fake.callsOf('branch_checkout')).toHaveLength(3);
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(graph.selection).toMatchObject({ oids: [oid(42)] }));
    end();
  });
});

describe('palette: commits (#)', () => {
  it("lists the newest loaded commits, then searches the whole history once typing settles and selects the pick", async () => {
    await openShell({ log_search: () => ({ matches: [{ oid: oid(60), row: 0 }, { oid: FAR, row: 700 }], truncated: false }) });
    await palette('#');
    expect(screen.getByTestId('palette')).toHaveAttribute('data-mode', 'commits');
    expect(headings()).toEqual(['Latest commits']);
    expect(items()).toHaveLength(30);
    expect(items()[0]).toHaveAttribute('data-oid', oid(60));
    expect(items()[0]).toHaveTextContent('main, origin/main');
    expect(fake.callsOf('log_search')).toHaveLength(0);

    await userEvent.type(screen.getByTestId('palette-input'), 'login');
    await waitFor(() => expect(labelsOf()).toEqual(['feat: login form', 'fix: a login crash from long ago']));
    expect(fake.callsOf('log_search').map((c) => c.args)).toEqual([{ repoId: 1, query: 'login', limit: 15 }]); // one call for the burst
    // the loaded commit costs nothing; the far one is read back as a single row
    expect(fake.callsOf('log_page').filter((c) => c.args.startRow === 700).map((c) => c.args)).toEqual([{ repoId: 1, cursor: null, startRow: 700, limit: 1 }]);
    expect(items()[1]).toHaveTextContent(FAR.slice(0, 7));
    expect(marks(items()[0]!)).toBe('login');

    // Closing forgets the results: the next `#` lists the loaded commits again.
    await closePalette();
    await palette('#');
    expect(items()).toHaveLength(30);
    await closePalette();

    // Enter selects a commit the graph had not loaded.
    await palette('#login');
    await waitFor(() => expect(items()).toHaveLength(2));
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(screen.queryByTestId('palette')).toBeNull();
    await waitFor(() => expect(graph.selection).toEqual({ kind: 'commits', oids: [FAR], anchor: FAR }));
  });

  it("says it is searching, drops the answer for text typed over, flags a long result, and ends a failure as 'no commit matches'", async () => {
    let release!: (v: unknown) => void;
    let answer: (a: Record<string, unknown>) => unknown = () => new Promise((r) => (release = r));
    await openShell({ log_search: (a) => answer(a) });

    // Searching, with the status and aria-busy to say so; then nothing matches.
    await palette('#nothing');
    await waitFor(() => expect(screen.getByTestId('palette-empty')).toHaveTextContent('Searching...'));
    expect(screen.getByTestId('palette-status')).toHaveTextContent('Searching...');
    expect(screen.getByTestId('palette-list')).toHaveAttribute('aria-busy', 'true');
    await waitFor(() => expect(fake.callsOf('log_search')).toHaveLength(1)); // the search starts once typing pauses
    release({ matches: [], truncated: false });
    await waitFor(() => expect(screen.getByTestId('palette-empty')).toHaveTextContent('No commit matches'));
    expect(screen.getByTestId('palette-list')).toHaveAttribute('aria-busy', 'false');
    await closePalette();

    // An answer for text that was since replaced is dropped.
    answer = (a) => (a.query === 'old' ? new Promise((r) => (release = r)) : { matches: [{ oid: oid(59), row: 1 }], truncated: false });
    const input = await palette('#old');
    await waitFor(() => expect(fake.callsOf('log_search').at(-1)!.args.query).toBe('old'));
    await userEvent.clear(input);
    await userEvent.type(input, '#new');
    await waitFor(() => expect(labelsOf()).toEqual(['feat: command palette']));
    release({ matches: [{ oid: oid(60), row: 0 }], truncated: false });
    await whenIdle();
    expect(labelsOf()).toEqual(['feat: command palette']); // not 'feat: login form', the answer for 'old'
    await closePalette();

    // More matches than the palette lists.
    const matches = Array.from({ length: 16 }, (_, i) => ({ oid: oid(60 - i), row: i }));
    answer = () => ({ matches, truncated: true });
    await palette('#feat');
    await waitFor(() => expect(items()).toHaveLength(15));
    expect(screen.getByTestId('palette-truncated')).toHaveTextContent('Showing the first 15 matches');
    await closePalette();

    // A failed search ends as "no commit matches", not "searching" for ever.
    answer = () => { throw { code: 'GIT_FAILED', message: 'boom', details: {} }; };
    await palette('#boom');
    await waitFor(() => expect(screen.getByTestId('palette-empty')).toHaveTextContent('No commit matches'));
  });

  it("ignores Enter while the search for the text typed is out (the list still answers the previous text), then picks from the new answer", async () => {
    let release!: (v: unknown) => void;
    await openShell({
      log_search: (a) => (a.query === 'login' ? { matches: [{ oid: oid(60), row: 0 }], truncated: false } : new Promise((r) => (release = r))),
    });
    const input = await palette('#login');
    await waitFor(() => expect(labelsOf()).toEqual(['feat: login form']));

    // One more letter: the stale answer stays listed, but Enter must not jump to it.
    const before = graph.selection;
    await userEvent.type(input, 's');
    await waitFor(() => expect(screen.getByTestId('palette-status')).toHaveTextContent('Searching...'));
    await waitFor(() => expect(fake.callsOf('log_search').at(-1)!.args.query).toBe('logins'));
    expect(labelsOf()).toEqual(['feat: login form']);
    await userEvent.keyboard('{Enter}');
    expect(screen.getByTestId('palette')).toBeInTheDocument();
    expect(graph.selection).toBe(before);

    // The answer arrives: Enter works again, on the new first result.
    release({ matches: [{ oid: oid(59), row: 1 }], truncated: false });
    await waitFor(() => expect(labelsOf()).toEqual(['feat: command palette']));
    await userEvent.keyboard('{Enter}');
    expect(screen.queryByTestId('palette')).toBeNull();
    await waitFor(() => expect(graph.selection).toEqual({ kind: 'commits', oids: [oid(59)], anchor: oid(59) }));
  });
});

describe('palette: repositories (/)', () => {
  it("lists the open tab then the recent ones, opens a recent repository in a new tab and switches to an open one", async () => {
    await openShell();
    const first = activeSession.current;
    await palette('/');
    expect(screen.getByTestId('palette')).toHaveAttribute('data-mode', 'repos');
    expect(headings()).toEqual(['Open repositories', 'Recent repositories']);
    expect(labelsOf()).toEqual(['gitmini-demo', 'api-server', 'website']);
    expect(items()[0]).toHaveAttribute('data-current', 'true');
    expect(items()[0]).toHaveTextContent('/Users/demo/dev/gitmini-demo');

    // A recent repository opens in a new tab.
    await userEvent.type(screen.getByTestId('palette-input'), 'api');
    expect(labelsOf()).toEqual(['api-server']);
    await userEvent.keyboard('{Enter}');
    expect(screen.queryByTestId('palette')).toBeNull();
    await whenIdle();
    expect(fake.callsOf('repo_open').at(-1)!.args).toEqual({ path: SECOND });
    expect(repo.tabs).toHaveLength(2);
    expect(activeSession.current.info?.name).toBe('api-server');

    // An open tab is switched to, not opened again; the tab takes the focus.
    await palette('/gitmini');
    expect(items()[0]).toHaveAttribute('data-path', '/Users/demo/dev/gitmini-demo');
    expect(items()[0]).not.toHaveAttribute('data-current');
    const opened = fake.callsOf('repo_open').length;
    await userEvent.keyboard('{Enter}');
    await whenIdle();
    expect(activeSession.current).toBe(first);
    expect(fake.callsOf('repo_open')).toHaveLength(opened);
    await waitFor(() => expect(document.activeElement).toHaveAttribute('role', 'tab'));

    // Nothing matches.
    await palette('/zzzz');
    expect(screen.getByTestId('palette-empty')).toHaveTextContent('No repository matches');
  });

  it("without a repository: `@` and `#` ask for one, `/` opens a recent repository from the welcome screen", async () => {
    await openShell({}, { repo: false });
    await palette('@');
    expect(items()).toHaveLength(0);
    expect(screen.getByTestId('palette-empty')).toHaveTextContent('Open a repository to search its branches and tags');
    await userEvent.type(screen.getByTestId('palette-input'), '{Backspace}#fix');
    expect(screen.getByTestId('palette-empty')).toHaveTextContent('Open a repository to search its commits');
    expect(fake.callsOf('log_search')).toHaveLength(0);

    await userEvent.type(screen.getByTestId('palette-input'), '{Backspace}{Backspace}{Backspace}{Backspace}/web');
    expect(labelsOf()).toEqual(['website']);
    await userEvent.keyboard('{Enter}');
    await whenIdle();
    expect(fake.callsOf('repo_open').at(-1)!.args).toEqual({ path: '/Users/demo/dev/website' });
  });
});

describe('palette: keyboard and screen reader', () => {
  it("announces the number of results, keeps aria-activedescendant on the selected option and wraps across the headings", async () => {
    await openShell();
    const input = await palette('@');
    expect(screen.getByTestId('palette-status')).toHaveTextContent('8 results');
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant', items()[2]!.id);
    expect(items()[2]).toHaveAttribute('aria-selected', 'true');
    await userEvent.type(input, 'topic');
    expect(screen.getByTestId('palette-status')).toHaveTextContent('1 result');
    await userEvent.clear(input);
    await userEvent.type(input, '@zzzz');
    expect(screen.getByTestId('palette-status')).toHaveTextContent('No results');
    expect(input).not.toHaveAttribute('aria-activedescendant');

    await userEvent.clear(input);
    await userEvent.type(input, '@');
    await userEvent.keyboard('{ArrowUp}');
    expect(items().at(-1)).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{ArrowDown}');
    expect(items()[0]).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{End}');
    expect(items().at(-1)).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Home}');
    expect(items()[0]).toHaveAttribute('aria-selected', 'true');
  });

  it("Escape and the shortcut that opened the palette close it, focus back where it was; a picked item keeps the typing focus", async () => {
    await openShell();
    const button = screen.getByTestId('toolbar-settings-btn');
    button.focus();
    await palette('@top');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('palette')).toBeNull();
    expect(document.activeElement).toBe(button);

    await userEvent.keyboard('{Control>}k{/Control}');
    const input = await screen.findByTestId('palette-input');
    await waitFor(() => expect(document.activeElement).toBe(input));
    await userEvent.keyboard('{Control>}k{/Control}');
    await waitFor(() => expect(screen.queryByTestId('palette')).toBeNull());
    expect(document.activeElement).toBe(button);

    await palette('@');
    await userEvent.pointer({ keys: '[MouseLeft>]', target: items()[1] });
    expect(document.activeElement).toBe(screen.getByTestId('palette-input'));
    await userEvent.pointer({ keys: '[/MouseLeft]' });
  });

  it("switching tab closes the palette and forgets what was typed", async () => {
    await openShell();
    await repo.open(SECOND);
    await whenIdle();
    await palette('@top');
    repo.cycle(1);
    await waitFor(() => expect(screen.queryByTestId('palette')).toBeNull());
    await palette();
    expect(screen.getByTestId('palette-input')).toHaveValue('');
  });
});
