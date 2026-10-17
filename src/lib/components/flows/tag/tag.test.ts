// "tags" flow: menu entries, `tag-create-dialog`, deletion with its undo toast, push to one or several remotes, deletion on a
// remote behind its confirmation, sidebar controls.
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { whenIdle } from '$lib/activity';
import { actionContext, actionDisabledReason, getAction, runAction } from '$lib/actions/registry';
import DialogHost from '$lib/components/dialogs-base/DialogHost.svelte';
import '$lib/components/dialogs-base/register';
import Sidebar from '$lib/components/sidebar/Sidebar.svelte';
import ToastContainer from '$lib/components/toast/ToastContainer.svelte';
import { preloadDialog, registerDialog } from '$lib/dialogs/registry';
import { resolveMenu } from '$lib/menus/registry';
import type { RefsSnapshot, TagInfo, UndoStatus } from '$lib/ipc/types';
import { graph } from '$lib/stores/graph.svelte';
import { op } from '$lib/stores/op.svelte';
import { refs } from '$lib/stores/refs.svelte';
import { toast } from '$lib/stores/toast.svelte';
import { makeConflictState, makeRefs, makeRemotes, makeUndo, oid as fixtureOid } from '$lib/test/fixtures';
import { resetAll } from '$lib/test/reset';
import { openTestRepo } from '../test-support';
import '$lib/register-core';
import './register';

const tid = (id: string) => screen.getByTestId(id);
const maybe = (id: string) => screen.queryByTestId(id);
const at55 = { menu: 'commit' as const, oid: fixtureOid(55), oids: [fixtureOid(55)] };
const lightweight = makeRefs().tags[0]!; // v0.1.0
const tagTarget = (tag: TagInfo) => ({ menu: 'tag' as const, tag });
const withTag = (tag: TagInfo): RefsSnapshot => ({ ...makeRefs(), tags: [tag, ...makeRefs().tags] });
const newTag = (name: string, annotated = false): TagInfo => ({ name, fullRef: `refs/tags/${name}`, oid: annotated ? fixtureOid(3000) : fixtureOid(55), targetOid: fixtureOid(55), annotated });
const secondRemote = { ...makeRemotes()[0]!, name: 'fork' };

beforeAll(async () => {
  await Promise.all(['tag-create-dialog', 'tag-push-dialog', 'tag-remote-delete-dialog'].map((id) => preloadDialog(id)));
}, 30_000);

beforeEach(() => resetAll({ keepRegistrations: true }));

function menuItem(target: Parameters<typeof resolveMenu>[0], id: string) {
  return resolveMenu(target).find((i) => i.id === id);
}

describe('menu entries', () => {
  it('commit menu: create a tag for a single commit only; usable during an operation, not while a write is in flight', async () => {
    await openTestRepo();
    expect(menuItem(at55, 'create-tag')).toMatchObject({ label: 'Create a tag here...', disabled: false });
    const many = { menu: 'commit' as const, oid: fixtureOid(55), oids: [fixtureOid(55), fixtureOid(54)] };
    expect(resolveMenu(many).map((i) => i.id)).not.toContain('create-tag');
    // a conflicted rebase does not stop a tag: it changes no state
    op.setState(makeConflictState());
    expect(menuItem(at55, 'create-tag')!.disabled).toBe(false);
    const end = op.begin('Fetch');
    expect(menuItem(at55, 'create-tag')!.disabled).toBe(true);
    end();
  });

  it('tag menu: push names the only remote, asks for the choice with several, hides without any; the deletions are the destructive entries', async () => {
    await openTestRepo({ remote_list: () => makeRemotes() });
    const ids = (t: TagInfo) => resolveMenu(tagTarget(t)).map((i) => i.id);
    expect(ids(lightweight)).toEqual(['checkout-detached', 'push', 'copy-name', 'delete', 'delete-remote']);
    expect(menuItem(tagTarget(lightweight), 'push')!.label).toBe('Push to origin');
    expect(menuItem(tagTarget(lightweight), 'delete')).toMatchObject({ label: 'Delete tag', danger: true, disabled: false });
    expect(menuItem(tagTarget(lightweight), 'delete-remote')).toMatchObject({ label: 'Delete on origin...', danger: true, disabled: false });
    refs.remotes = [...makeRemotes(), secondRemote];
    expect(menuItem(tagTarget(lightweight), 'push')!.label).toBe('Push to...');
    expect(menuItem(tagTarget(lightweight), 'delete-remote')!.label).toBe('Delete on a remote...');
    refs.remotes = [];
    expect(ids(lightweight)).not.toContain('push');
    expect(ids(lightweight)).not.toContain('delete-remote');
  });

  it('palette action: refused without a repository and on an unborn HEAD, with the reason', async () => {
    expect(actionDisabledReason(getAction('tag.create')!, actionContext())).toBe('No repository open');
    await openTestRepo({ refs_list: () => ({ ...makeRefs(), head: { kind: 'unborn', name: 'main' } }) });
    expect(actionDisabledReason(getAction('tag.create')!, actionContext())).toBe('There is no commit to tag yet.');
  });
});

describe('tag-create-dialog', () => {
  async function open(handlers: Record<string, () => unknown> = {}) {
    const fake = await openTestRepo({ tag_create: () => withTag(newTag('v1.0.0')), ...handlers });
    render(DialogHost);
    return fake;
  }

  it('shows the tagged commit, validates the name live and refuses a tag that exists', async () => {
    await open();
    void menuItem(at55, 'create-tag')!.run();
    const input = (await screen.findByTestId('tag-create-name-input')) as HTMLInputElement;
    expect(tid('tag-create-target')).toHaveTextContent(fixtureOid(55).slice(0, 7));
    expect(tid('tag-create-submit-btn')).toBeDisabled();
    expect(maybe('tag-create-error')).toBeNull();

    await userEvent.type(input, 'my tag');
    expect(input.value).toBe('my-tag');
    expect(tid('tag-create-submit-btn')).toBeEnabled();

    await userEvent.clear(input);
    await userEvent.type(input, 'a..b');
    expect(tid('tag-create-error')).toHaveTextContent('Invalid tag name: cannot contain "..".');
    expect(tid('tag-create-submit-btn')).toBeDisabled();

    await userEvent.clear(input);
    await userEvent.type(input, lightweight.name);
    expect(tid('tag-create-error')).toHaveTextContent(`A tag named "${lightweight.name}" already exists.`);
    expect(tid('tag-create-submit-btn')).toBeDisabled();
  });

  it('creates a lightweight tag on the chosen commit, applies the answer, closes and says where', async () => {
    const fake = await open();
    void menuItem(at55, 'create-tag')!.run();
    await userEvent.type(await screen.findByTestId('tag-create-name-input'), 'v1.0.0');
    expect(tid('tag-create-dialog')).toHaveAttribute('data-annotated', 'false');
    await userEvent.click(tid('tag-create-submit-btn'));
    await waitFor(() => expect(fake.callsOf('tag_create')).toHaveLength(1));
    await whenIdle();
    expect(fake.callsOf('tag_create')[0]!.args).toEqual({ repoId: 1, name: 'v1.0.0', target: fixtureOid(55), message: null });
    expect(maybe('tag-create-dialog')).toBeNull();
    expect(refs.snapshot!.tags.map((t) => t.name)).toContain('v1.0.0');
    expect(toast.items.at(-1)?.message).toBe(`Tag "v1.0.0" created on ${fixtureOid(55).slice(0, 7)}.`);
  });

  it('a message makes it annotated; Enter in the name field submits, Enter in the message does not', async () => {
    const fake = await open({ tag_create: () => withTag(newTag('v2', true)) });
    void runAction('tag.create');
    const input = await screen.findByTestId('tag-create-name-input');
    expect(tid('tag-create-target')).toHaveTextContent('HEAD (main)');
    await userEvent.type(input, 'v2');
    await userEvent.type(tid('tag-create-message-input'), '  Second release{Enter}more{Enter}');
    expect(fake.callsOf('tag_create')).toHaveLength(0);
    expect(tid('tag-create-dialog')).toHaveAttribute('data-annotated', 'true');
    input.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(fake.callsOf('tag_create')).toHaveLength(1));
    // HEAD: the backend resolves it, the message is sent trimmed
    expect(fake.callsOf('tag_create')[0]!.args).toEqual({ repoId: 1, name: 'v2', target: null, message: 'Second release\nmore' });
  });

  it('a refusal by the backend stays under the field and keeps the dialog open', async () => {
    await open({
      tag_create: () => {
        throw { code: 'ALREADY_EXISTS', message: 'x', details: { what: 'tag', name: 'v9' } };
      },
    });
    void runAction('tag.create');
    await userEvent.type(await screen.findByTestId('tag-create-name-input'), 'v9');
    await userEvent.click(tid('tag-create-submit-btn'));
    expect(await screen.findByTestId('tag-create-error')).toHaveTextContent('A tag named "v9" already exists.');
    expect(tid('tag-create-dialog')).toBeInTheDocument();
    expect(toast.items).toHaveLength(0);
  });

  it('an annotated tag without a git identity asks for it, then creates the tag and closes', async () => {
    registerDialog('identity-dialog', () => import('$lib/components/identity/IdentityDialog.svelte'));
    await preloadDialog('identity-dialog');
    let attempts = 0;
    const fake = await open({
      tag_create: () => {
        if (attempts++ === 0) throw { code: 'IDENTITY_MISSING', message: 'who are you', details: {} };
        return withTag(newTag('v2', true));
      },
      config_set_identity: () => ({ name: 'Ada', email: 'ada@x.io', scope: 'global' }),
    });
    void runAction('tag.create');
    await userEvent.type(await screen.findByTestId('tag-create-name-input'), 'v2');
    await userEvent.type(tid('tag-create-message-input'), 'Second release');
    await userEvent.click(tid('tag-create-submit-btn'));
    await userEvent.type(await screen.findByTestId('identity-name-input'), 'Ada');
    await userEvent.type(tid('identity-email-input'), 'ada@x.io');
    await userEvent.click(tid('identity-save-btn'));
    await waitFor(() => expect(fake.callsOf('tag_create')).toHaveLength(2));
    await whenIdle();
    expect(fake.callsOf('tag_create')[1]!.args).toEqual(fake.callsOf('tag_create')[0]!.args);
    expect(maybe('identity-dialog')).toBeNull();
    expect(maybe('tag-create-dialog')).toBeNull();
    expect(refs.snapshot!.tags.map((t) => t.name)).toContain('v2');
  });

  it('cancel calls nothing', async () => {
    const fake = await open();
    void runAction('tag.create');
    await screen.findByTestId('tag-create-dialog');
    await userEvent.click(tid('tag-create-cancel-btn'));
    await waitFor(() => expect(maybe('tag-create-dialog')).toBeNull());
    expect(fake.callsOf('tag_create')).toHaveLength(0);
  });
});

describe('delete', () => {
  const deleted = { deletedOid: lightweight.oid, refs: { ...makeRefs(), tags: makeRefs().tags.slice(1) } };
  const undoOffer = (): UndoStatus => {
    const u = makeUndo(true);
    return { ...u, entry: { ...u.entry!, id: 'undo-tag', kind: 'tag-delete', label: 'Restore the v0.1.0 tag', refName: 'refs/tags/v0.1.0', before: lightweight.oid } };
  };

  it('deletes without confirmation and offers the undo, which restores the tag', async () => {
    const fake = await openTestRepo({ tag_delete: () => deleted, undo_peek: undoOffer, undo_last: () => ({ head: { branch: 'main', oid: fixtureOid(60), detached: false, unborn: false } }) });
    render(ToastContainer);
    await menuItem(tagTarget(lightweight), 'delete')!.run();
    await whenIdle();
    expect(fake.callsOf('tag_delete')[0]!.args).toEqual({ repoId: 1, name: 'v0.1.0' });
    expect(refs.snapshot!.tags.map((t) => t.name)).toEqual(['v0.2.0']);
    const offer = toast.items.find((t) => t.kind === 'undo')!;
    expect(offer.message).toBe('Tag "v0.1.0" deleted.');
    await userEvent.click(await screen.findByTestId('toast-undo-btn'));
    await whenIdle();
    expect(fake.callsOf('undo_last')[0]!.args).toMatchObject({ repoId: 1, entryId: 'undo-tag' });
  });

  it('without an undo entry from the backend the toast is a plain confirmation', async () => {
    await openTestRepo({ tag_delete: () => deleted });
    await menuItem(tagTarget(lightweight), 'delete')!.run();
    await whenIdle();
    expect(toast.items.some((t) => t.kind === 'undo')).toBe(false);
    expect(toast.items.at(-1)?.message).toBe('Tag "v0.1.0" deleted.');
  });

  it('a tag already gone is reported and the refs are read again', async () => {
    const fake = await openTestRepo({
      tag_delete: () => {
        throw { code: 'NOT_FOUND', message: 'x', details: { what: 'ref', name: 'v0.1.0' } };
      },
    });
    await menuItem(tagTarget(lightweight), 'delete')!.run();
    await whenIdle();
    expect(toast.items.at(-1)?.message).toBe('The tag "v0.1.0" no longer exists.');
    expect(fake.callsOf('refs_list').length).toBeGreaterThan(1);
  });

  it('is refused while a write is in flight', async () => {
    const fake = await openTestRepo({ tag_delete: () => deleted });
    const end = op.begin('Fetch');
    expect(menuItem(tagTarget(lightweight), 'delete')!.disabled).toBe(true);
    expect(await runAction('tag.delete', tagTarget(lightweight))).toBe(false);
    expect(fake.callsOf('tag_delete')).toHaveLength(0);
    end();
  });
});

describe('push', () => {
  it('goes straight to the only remote and says so', async () => {
    const fake = await openTestRepo({ remote_list: () => makeRemotes(), tag_push: () => null });
    await menuItem(tagTarget(lightweight), 'push')!.run();
    await whenIdle();
    const call = fake.callsOf('tag_push')[0]!.args as Record<string, unknown>;
    expect(call).toMatchObject({ repoId: 1, remote: 'origin', name: 'v0.1.0' });
    expect(typeof call.opId).toBe('string');
    expect(maybe('tag-push-dialog')).toBeNull();
    expect(toast.items.at(-1)?.message).toBe('Tag "v0.1.0" pushed to origin.');
  });

  it('with several remotes asks which one, origin preselected', async () => {
    const fake = await openTestRepo({ remote_list: () => [secondRemote, ...makeRemotes()], tag_push: () => null });
    render(DialogHost);
    const running = menuItem(tagTarget(lightweight), 'push')!.run();
    const select = (await screen.findByTestId('tag-push-remote-select')) as HTMLSelectElement;
    expect(select.value).toBe('origin');
    await userEvent.selectOptions(select, 'fork');
    await userEvent.click(tid('tag-push-submit-btn'));
    await running;
    await whenIdle();
    expect(fake.callsOf('tag_push')[0]!.args).toMatchObject({ remote: 'fork', name: 'v0.1.0' });
    expect(toast.items.at(-1)?.message).toBe('Tag "v0.1.0" pushed to fork.');
  });

  it('cancelling the choice pushes nothing', async () => {
    const fake = await openTestRepo({ remote_list: () => [secondRemote, ...makeRemotes()], tag_push: () => null });
    render(DialogHost);
    const running = menuItem(tagTarget(lightweight), 'push')!.run();
    await userEvent.click(await screen.findByTestId('tag-push-cancel-btn'));
    await running;
    expect(fake.callsOf('tag_push')).toHaveLength(0);
  });

  it('a different tag already on the remote is explained, not shown as a git failure', async () => {
    await openTestRepo({
      remote_list: () => makeRemotes(),
      tag_push: () => {
        throw { code: 'ALREADY_EXISTS', message: 'raw', details: { what: 'remote-tag', name: 'v0.1.0', remote: 'origin' } };
      },
    });
    await menuItem(tagTarget(lightweight), 'push')!.run();
    await whenIdle();
    const last = toast.items.at(-1)!;
    expect(last.kind).toBe('error');
    expect(last.message).toBe('origin already has a different tag named "v0.1.0". Choose another name, or delete that tag on the remote (tag menu, "Delete on origin...") and push again.');
  });
});

describe('delete on a remote', () => {
  const lastToast = () => toast.items.at(-1)!;

  it('names the tag and the remote, warns that it cannot be undone, and focuses Cancel', async () => {
    const fake = await openTestRepo({ remote_list: () => makeRemotes(), tag_push: () => null });
    render(DialogHost);
    const running = menuItem(tagTarget(lightweight), 'delete-remote')!.run();
    await screen.findByTestId('tag-remote-delete-dialog');
    expect(tid('tag-remote-delete-dialog')).toHaveTextContent('Delete tag "v0.1.0" on a remote');
    expect(tid('tag-remote-delete-message')).toHaveTextContent('Delete the tag "v0.1.0" from origin? Your local tag is kept.');
    expect(tid('tag-remote-delete-warning')).toHaveTextContent('This cannot be undone from Gitmini.');
    expect(tid('tag-remote-delete-submit-btn')).toHaveTextContent('Delete on origin');
    expect(maybe('tag-remote-delete-remote-select')).toBeNull(); // a single remote: nothing to choose
    expect(tid('tag-remote-delete-cancel-btn')).toHaveFocus();
    await userEvent.click(tid('tag-remote-delete-cancel-btn'));
    await running;
    await whenIdle();
    expect(maybe('tag-remote-delete-dialog')).toBeNull();
    expect(fake.callsOf('tag_push')).toHaveLength(0);
    expect(toast.items).toHaveLength(0);
  });

  it('confirming deletes on the remote only: the local tag stays and nothing is offered to undo', async () => {
    const fake = await openTestRepo({ remote_list: () => makeRemotes(), tag_push: () => null });
    render(DialogHost);
    const running = menuItem(tagTarget(lightweight), 'delete-remote')!.run();
    await userEvent.click(await screen.findByTestId('tag-remote-delete-submit-btn'));
    await running;
    await whenIdle();
    const call = fake.callsOf('tag_push')[0]!.args as Record<string, unknown>;
    expect(call).toMatchObject({ repoId: 1, remote: 'origin', name: 'v0.1.0', delete: true });
    expect(typeof call.opId).toBe('string');
    expect(fake.callsOf('tag_delete')).toHaveLength(0);
    expect(maybe('tag-remote-delete-dialog')).toBeNull();
    expect(refs.snapshot!.tags.map((t) => t.name)).toContain('v0.1.0');
    expect(lastToast()).toMatchObject({ kind: 'success', message: 'Tag "v0.1.0" deleted on origin.' });
    expect(toast.items.some((t) => t.kind === 'undo')).toBe(false);
  });

  it('with several remotes asks which one (origin first), and the text and the button follow the choice', async () => {
    const fake = await openTestRepo({ remote_list: () => [secondRemote, ...makeRemotes()], tag_push: () => null });
    render(DialogHost);
    const running = menuItem(tagTarget(lightweight), 'delete-remote')!.run();
    const select = (await screen.findByTestId('tag-remote-delete-remote-select')) as HTMLSelectElement;
    expect(select.value).toBe('origin');
    expect(tid('tag-remote-delete-message')).toHaveTextContent('from origin?');
    await userEvent.selectOptions(select, 'fork');
    expect(tid('tag-remote-delete-message')).toHaveTextContent('Delete the tag "v0.1.0" from fork? Your local tag is kept.');
    expect(tid('tag-remote-delete-warning')).toHaveTextContent('push it again');
    expect(tid('tag-remote-delete-submit-btn')).toHaveTextContent('Delete on fork');
    await userEvent.click(tid('tag-remote-delete-submit-btn'));
    await running;
    await whenIdle();
    expect(fake.callsOf('tag_push')[0]!.args).toMatchObject({ remote: 'fork', name: 'v0.1.0', delete: true });
    expect(lastToast().message).toBe('Tag "v0.1.0" deleted on fork.');
  });

  it('Enter on the dialog does not confirm: Cancel has the focus', async () => {
    const fake = await openTestRepo({ remote_list: () => makeRemotes(), tag_push: () => null });
    render(DialogHost);
    const running = menuItem(tagTarget(lightweight), 'delete-remote')!.run();
    await screen.findByTestId('tag-remote-delete-dialog');
    await userEvent.keyboard('{Enter}');
    await running;
    expect(fake.callsOf('tag_push')).toHaveLength(0);
    expect(maybe('tag-remote-delete-dialog')).toBeNull();
  });

  it('a remote that lacks the tag is reported as an error, not as a success', async () => {
    await openTestRepo({
      remote_list: () => makeRemotes(),
      tag_push: () => {
        throw { code: 'NOT_FOUND', message: 'raw', details: { what: 'remote-tag', name: 'v0.1.0', remote: 'origin' } };
      },
    });
    render(DialogHost);
    const running = menuItem(tagTarget(lightweight), 'delete-remote')!.run();
    await userEvent.click(await screen.findByTestId('tag-remote-delete-submit-btn'));
    await running;
    await whenIdle();
    expect(lastToast()).toMatchObject({ kind: 'error', message: 'origin has no tag named "v0.1.0".' });
    expect(toast.items.some((t) => t.kind === 'success')).toBe(false);
  });

  it('is refused while a write is in flight, and without a remote the entry is not offered', async () => {
    const fake = await openTestRepo({ remote_list: () => makeRemotes(), tag_push: () => null });
    const end = op.begin('Fetch');
    expect(menuItem(tagTarget(lightweight), 'delete-remote')!.disabled).toBe(true);
    expect(await runAction('tag.deleteRemote', tagTarget(lightweight))).toBe(false);
    end();
    refs.remotes = [];
    expect(menuItem(tagTarget(lightweight), 'delete-remote')).toBeUndefined();
    expect(await runAction('tag.deleteRemote', tagTarget(lightweight))).toBe(false);
    expect(fake.callsOf('tag_push')).toHaveLength(0);
  });
});

describe('sidebar', () => {
  it('the + button of the Tags section opens the dialog on HEAD, whatever commit is selected', async () => {
    await openTestRepo();
    render(DialogHost);
    render(Sidebar);
    graph.selectCommit(fixtureOid(55));
    await userEvent.click(tid('sidebar-tag-create-btn'));
    expect(await screen.findByTestId('tag-create-dialog')).toBeInTheDocument();
    expect(tid('tag-create-target')).toHaveTextContent('HEAD (main)');
  });

  it('the + button is disabled, with the reason, on an unborn HEAD', async () => {
    await openTestRepo({ refs_list: () => ({ ...makeRefs(), head: { kind: 'unborn', name: 'main' } }) });
    render(Sidebar);
    expect(tid('sidebar-tag-create-btn')).toBeDisabled();
    expect(tid('sidebar-tag-create-btn')).toHaveAttribute('title', 'There is no commit to tag yet.');
  });

  it('Delete on a focused tag deletes it (undoable); annotated tags are flagged', async () => {
    const fake = await openTestRepo({ tag_delete: () => ({ deletedOid: lightweight.oid, refs: { ...makeRefs(), tags: [] } }) });
    render(Sidebar);
    const items = screen.getAllByTestId('sidebar-tag-item');
    expect(items.map((e) => e.dataset.annotated)).toEqual(['false', 'true']);
    items[0]!.focus();
    await userEvent.keyboard('{Delete}');
    await whenIdle();
    expect(fake.callsOf('tag_delete')[0]!.args).toEqual({ repoId: 1, name: 'v0.1.0' });
    expect(screen.queryAllByTestId('sidebar-tag-item')).toHaveLength(0);
  });
});
