// Folder picker flow: a folder that is not a repository is offered `git init` (`repo.openOrInit`).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { whenIdle } from '../activity';
import { confirmAction } from '../dialogs/confirm';
import { installErrorRouting } from '../errors/handle';
import { createFakeTransport, type FakeTransport } from '../test/fake-transport';
import { makeAppInfo, makeLogPage, makeRefs, makeRemotes, makeRepoInfo, makeStashes, makeStatus, makeUndo } from '../test/fixtures';
import { resetAll } from '../test/reset';
import { repo } from './repo.svelte';
import { toast } from './toast.svelte';
import { unwireEvents, wireEvents } from './wiring';

vi.mock('../dialogs/confirm', () => ({ confirmAction: vi.fn() }));
const confirm = vi.mocked(confirmAction);

const NOT_A_REPO = { code: 'NOT_A_REPO', message: 'not a repository', details: { path: '/plain' } } as const;

let fake: FakeTransport;

beforeEach(() => {
  resetAll();
  installErrorRouting();
  confirm.mockReset();
  fake = createFakeTransport({
    app_info: () => makeAppInfo(),
    settings_get: () => ({}),
    repo_recent_list: () => [],
    repo_open: () => makeRepoInfo(),
    repo_init: () => makeRepoInfo({ workdir: '/plain', name: 'plain' }),
    repo_close: () => null,
    log_page: () => makeLogPage(),
    refs_list: () => makeRefs(),
    remote_list: () => makeRemotes(),
    stash_list: () => makeStashes(),
    status_get: () => makeStatus(),
    undo_peek: () => makeUndo(),
    settings_set: () => null,
  }).install();
  wireEvents();
});

afterEach(() => {
  unwireEvents();
});

describe('open with offerInit', () => {
  it('a plain folder sets neither openError nor a toast', async () => {
    await repo.open('/other');
    fake.reject('repo_open', NOT_A_REPO);
    expect(await repo.open('/plain', { offerInit: true })).toBe(false);
    expect(repo.openError).toBeNull();
    expect(toast.items).toHaveLength(0);
  });

  it.each(['bare', 'dubious-ownership'])('%s keeps its error', async (reason) => {
    fake.reject('repo_open', { ...NOT_A_REPO, details: { path: '/plain', reason } });
    expect(await repo.open('/plain', { offerInit: true })).toBe(false);
    expect(repo.openError).toMatchObject({ code: 'NOT_A_REPO', reason });
  });

  it('without offerInit a plain folder still reports NOT_A_REPO', async () => {
    fake.reject('repo_open', NOT_A_REPO);
    expect(await repo.open('/plain')).toBe(false);
    expect(repo.openError).toMatchObject({ code: 'NOT_A_REPO', reason: null });
  });
});

describe('openOrInit', () => {
  it('confirmed: repo_init runs on the folder and the repository opens in a tab', async () => {
    fake.reject('repo_open', NOT_A_REPO);
    confirm.mockResolvedValue(true);
    expect(await repo.openOrInit('/plain')).toBe(true);
    await whenIdle();
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ action: 'repo-init' }));
    expect(fake.callsOf('repo_init')[0]!.args).toEqual({ path: '/plain' });
    expect(repo.tabs).toHaveLength(1);
    expect(repo.info?.workdir).toBe('/plain');
    expect(repo.openError).toBeNull();
  });

  it('cancelled: nothing is initialized and nothing is reported', async () => {
    fake.reject('repo_open', NOT_A_REPO);
    confirm.mockResolvedValue(false);
    expect(await repo.openOrInit('/plain')).toBe(false);
    expect(fake.callsOf('repo_init')).toHaveLength(0);
    expect(repo.tabs).toHaveLength(0);
    expect(repo.openError).toBeNull();
    expect(toast.items).toHaveLength(0);
  });

  it('a repository opens directly, without any prompt', async () => {
    expect(await repo.openOrInit('/r')).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(fake.callsOf('repo_init')).toHaveLength(0);
  });

  it('other open errors are not offered an init', async () => {
    fake.reject('repo_open', { code: 'NOT_FOUND', message: 'absent', details: { what: 'path' } });
    expect(await repo.openOrInit('/gone')).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(repo.openError?.code).toBe('NOT_FOUND');
  });

  it('a failing repo_init is reported and no tab is added', async () => {
    fake.reject('repo_open', NOT_A_REPO);
    confirm.mockResolvedValue(true);
    fake.reject('repo_init', { code: 'ALREADY_EXISTS', message: 'inside a repository', details: { what: 'repo' } });
    expect(await repo.openOrInit('/plain')).toBe(false);
    expect(repo.tabs).toHaveLength(0);
    expect(repo.opening).toBe(false);
  });
});
