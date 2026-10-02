// Toolbar Pull Menu (03): `toolbar-pull-menu-btn` opens `toolbar-pull-menu`; each entry sends the correct mode (10 §Pull).
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import App from '../../../../App.svelte';
import { whenIdle } from '$lib/activity';
import { bootstrap } from '$lib/bootstrap';
import { unwireEvents } from '$lib/stores/wiring';
import { createFakeTransport, type FakeTransport } from '$lib/test/fake-transport';
import { makeAppInfo, makeLogPage, makeRecents, makeRefs, makeRemotes, makeRepoInfo, makeStashes, makeStatus, makeUndo } from '$lib/test/fixtures';
import { resetAll } from '$lib/test/reset';
import '$lib/register-core';
import '$lib/register-domains';

let fake: FakeTransport;
const tid = (id: string) => screen.getByTestId(id);

beforeEach(() => {
  resetAll({ keepRegistrations: true });
  fake = createFakeTransport({
    app_info: () => makeAppInfo({ initialPath: '/r' }),
    settings_get: () => ({}),
    repo_recent_list: () => makeRecents(),
    repo_open: () => makeRepoInfo(),
    log_page: () => makeLogPage(),
    refs_list: () => makeRefs(),
    remote_list: () => makeRemotes(),
    stash_list: () => makeStashes(),
    status_get: () => makeStatus(),
    undo_peek: () => makeUndo(false),
    remote_pull: () => ({ head: { branch: 'main', oid: '0'.repeat(40), detached: false, unborn: false } }),
    remote_fetch: () => null,
  }).install();
});
afterEach(() => unwireEvents());

async function openMenu(): Promise<void> {
  render(App);
  await bootstrap();
  await screen.findByTestId('toolbar-pull-menu-btn');
  await whenIdle();
  await userEvent.click(tid('toolbar-pull-menu-btn'));
  await screen.findByTestId('toolbar-pull-menu');
}

describe('toolbar-pull-menu', () => {
  it("inputs fetch, ff-only, rebase", async () => {
    await openMenu();
    for (const id of ['toolbar-pull-menu-item-fetch', 'toolbar-pull-menu-item-ff-only', 'toolbar-pull-menu-item-rebase']) expect(tid(id)).toBeEnabled();
  });

  it('ff-only → remote_pull { mode: "ff-only" }', async () => {
    await openMenu();
    await userEvent.click(tid('toolbar-pull-menu-item-ff-only'));
    await whenIdle();
    expect(fake.callsOf('remote_pull')).toHaveLength(1);
    expect(fake.callsOf('remote_pull')[0]!.args).toMatchObject({ mode: 'ff-only' });
  });

  it('rebase → remote_pull { mode: "rebase" }', async () => {
    await openMenu();
    await userEvent.click(tid('toolbar-pull-menu-item-rebase'));
    await whenIdle();
    expect(fake.callsOf('remote_pull')[0]!.args).toMatchObject({ mode: 'rebase' });
  });

  it("fetch → remote_fetch of all remotes; the Pull button only does not send any mode", async () => {
    await openMenu();
    await userEvent.click(tid('toolbar-pull-menu-item-fetch'));
    await whenIdle();
    expect(fake.callsOf('remote_fetch')[0]!.args).toMatchObject({ remote: null, prune: true });
    await userEvent.click(tid('toolbar-pull-btn'));
    await whenIdle();
    expect(fake.callsOf('remote_pull')[0]!.args).not.toHaveProperty('mode');
  });
});
