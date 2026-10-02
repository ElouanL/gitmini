// Stream "branches" (06) : creation / renaming / forced deletion / checkout with dirty worktree.
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { whenIdle } from '$lib/activity';
import DialogHost from '$lib/components/dialogs-base/DialogHost.svelte';
import '$lib/components/dialogs-base/register';
import { openDialog, preloadDialog } from '$lib/dialogs/registry';
import { refs } from '$lib/stores/refs.svelte';
import { toast } from '$lib/stores/toast.svelte';
import { resetAll } from '$lib/test/reset';
import { makeRefs, oid as headOid } from '$lib/test/fixtures';
import { checkoutTarget } from '$lib/actions/checkout';
import { openTestRepo, oid } from '../test-support';
import './register';
import { registerBranchErrorHandlers } from './errors';
import { deleteBranch } from './ops';

const tid = (id: string) => screen.getByTestId(id);
const maybe = (id: string) => screen.queryByTestId(id);

// The dialogues are in lazy loading: they are downloaded once (the first dynamic import of a chunk is slow under vitest).
beforeAll(async () => {
  await Promise.all(['branch-create-dialog', 'branch-rename-dialog', 'branch-delete-force-dialog', 'checkout-dirty-dialog', 'checkout-remote-name-dialog'].map((id) => preloadDialog(id)));
}, 30_000);

beforeEach(() => {
  resetAll({ keepRegistrations: true });
  registerBranchErrorHandlers();
});

describe('branch-create-dialog', () => {
  it("validate the name live: spaces → dashes, rule broken under the field, button disabled", async () => {
    await openTestRepo();
    render(DialogHost);
    void openDialog('branch-create-dialog', { startPoint: null });
    const input = (await screen.findByTestId('branch-create-name-input')) as HTMLInputElement;
    expect(tid('branch-create-submit-btn')).toBeDisabled();
    expect(maybe('branch-create-error')).toBeNull();

    await userEvent.type(input, "my branch");
    expect(input.value).toBe("my-branch");
    expect(tid('branch-create-submit-btn')).toBeEnabled();

    await userEvent.clear(input);
    await userEvent.type(input, 'a..b');
    expect(tid('branch-create-error')).toHaveTextContent("Invalid branch name: cannot contain \"..\".");
    expect(tid('branch-create-submit-btn')).toBeDisabled();
  });

  it("creates the branch with checkout (checked by default), applies the answer and closes", async () => {
    const snapshot = makeRefs();
    const fake = await openTestRepo({ branch_create: () => snapshot });
    render(DialogHost);
    const done = openDialog('branch-create-dialog', { startPoint: oid('a') });
    await userEvent.type(await screen.findByTestId('branch-create-name-input'), 'topic');
    expect(tid('branch-create-checkout-toggle')).toBeChecked();
    expect(tid('branch-create-start-point')).toHaveTextContent('aaaaaaa');
    await userEvent.click(tid('branch-create-submit-btn'));
    await waitFor(() => expect(fake.callsOf('branch_create')).toHaveLength(1));
    expect(fake.callsOf('branch_create')[0]!.args).toEqual({ repoId: 1, name: 'topic', startPoint: oid('a'), checkout: true });
    expect(await done).toBe(true);
    expect(refs.snapshot).toEqual(snapshot);
    expect(maybe('branch-create-dialog')).toBeNull();
  });

  it("ALREADY_EXISTS: error under the field, open dialogue, no toast", async () => {
    const fake = await openTestRepo();
    fake.on('branch_create', () => {
      throw { code: 'ALREADY_EXISTS', message: 'existe', details: { what: 'branch', name: 'feature/x', blockedBy: 'feature' } };
    });
    render(DialogHost);
    void openDialog('branch-create-dialog', { startPoint: 'HEAD', checkout: false });
    await userEvent.type(await screen.findByTestId('branch-create-name-input'), 'feature/x');
    await userEvent.click(tid('branch-create-submit-btn'));
    expect(await screen.findByTestId('branch-create-error')).toHaveTextContent("The \"feature\" branch already exists and blocks \"feature/x\".");
    expect(tid('branch-create-dialog')).toBeInTheDocument();
    expect(toast.items).toHaveLength(0);
    // `branch-create-here-btn` sends startPoint 'HEAD': the dialog transmits the oid of HEAD, not a symbolic ref
    expect(fake.callsOf('branch_create')[0]!.args).toMatchObject({ startPoint: headOid(60), checkout: false });
  });

  it("DIRTY_WORKTREE: opens checkout-dirty-dialog, then \"Stasher and toggle\" restarts with autoStash { reapply }", async () => {
    const snapshot = makeRefs();
    const fake = await openTestRepo();
    let first = true;
    fake.on('branch_create', (a) => {
      if (first) {
        first = false;
        throw { code: 'DIRTY_WORKTREE', message: 'sale', details: { paths: ['mod.txt', 'a.txt'] } };
      }
      expect(a.autoStash).toEqual({ reapply: true });
      return snapshot;
    });
    render(DialogHost);
    const done = openDialog('branch-create-dialog', { startPoint: null });
    await userEvent.type(await screen.findByTestId('branch-create-name-input'), 'topic');
    await userEvent.click(tid('branch-create-submit-btn'));
    const dirty = await screen.findByTestId('checkout-dirty-dialog');
    expect(dirty).toBeInTheDocument();
    expect(tid('checkout-dirty-files')).toHaveTextContent('mod.txt');
    expect(tid('checkout-dirty-reapply-toggle')).toBeChecked();
    await userEvent.click(tid('checkout-dirty-stash-btn'));
    expect(await done).toBe(true);
    expect(fake.callsOf('branch_create')).toHaveLength(2);
    expect(fake.callsOf('branch_create')[1]!.args).toMatchObject({ name: 'topic', checkout: true, autoStash: { reapply: true } });
  });
});

describe('branch-rename-dialog', () => {
  it("pre-filled and selected; renamed; upstream retained is reported", async () => {
    const fake = await openTestRepo({ branch_rename: () => makeRefs() });
    render(DialogHost);
    void openDialog('branch-rename-dialog', { name: 'main' });
    const input = (await screen.findByTestId('branch-rename-input')) as HTMLInputElement;
    expect(input.value).toBe('main');
    expect(tid('branch-rename-upstream-note')).toHaveTextContent('origin/main');
    expect(tid('branch-rename-submit-btn')).toBeDisabled(); // unchanged
    await userEvent.clear(input);
    await userEvent.type(input, 'trunk');
    await userEvent.click(tid('branch-rename-submit-btn'));
    await waitFor(() => expect(fake.callsOf('branch_rename')).toHaveLength(1));
    expect(fake.callsOf('branch_rename')[0]!.args).toEqual({ repoId: 1, oldName: 'main', newName: 'trunk' });
    await waitFor(() => expect(maybe('branch-rename-dialog')).toBeNull());
  });

  it("ALREADY_EXISTS under the field", async () => {
    const fake = await openTestRepo();
    fake.on('branch_rename', () => {
      throw { code: 'ALREADY_EXISTS', message: 'x', details: { what: 'branch', name: 'topic' } };
    });
    render(DialogHost);
    void openDialog('branch-rename-dialog', { name: 'main' });
    const input = await screen.findByTestId('branch-rename-input');
    await userEvent.clear(input);
    await userEvent.type(input, 'topic');
    await userEvent.click(tid('branch-rename-submit-btn'));
    expect(await screen.findByTestId('branch-rename-error')).toHaveTextContent("A topic branch already exists.");
  });
});

describe("branch deletion", () => {
  it("NOT_MERGED → branch-delete-force-dialog → branch_delete { force: true } and toast d的undo", async () => {
    const fake = await openTestRepo({ undo_peek: () => ({ entry: null, available: false, reason: 'empty', head: oid('a') }) });
    let n = 0;
    fake.on('branch_delete', (a) => {
      if (n++ === 0) throw { code: 'NOT_MERGED', message: "not merged", details: { name: 'fix/typo', commits: 3 } };
      expect(a.force).toBe(true);
      return { deletedOid: oid('b'), refs: makeRefs() };
    });
    render(DialogHost);
    void deleteBranch('fix/typo');
    const dlg = await screen.findByTestId('branch-delete-force-dialog');
    expect(dlg).toHaveTextContent("3 commits missing");
    expect(dlg).toHaveTextContent('fix/typo');
    await userEvent.click(tid('branch-delete-force-btn'));
    await waitFor(() => expect(fake.callsOf('branch_delete')).toHaveLength(2));
    await whenIdle();
    await waitFor(() => expect(toast.items.some((t) => t.message.includes('fix/typo') && t.message.includes('bbbbbbb'))).toBe(true));
    expect(maybe('branch-delete-force-dialog')).toBeNull();
  });

  it("cancel forced deletion: no additional call", async () => {
    const fake = await openTestRepo();
    fake.on('branch_delete', () => {
      throw { code: 'NOT_MERGED', message: 'x', details: { name: 'fix/typo', commits: 1 } };
    });
    render(DialogHost);
    void deleteBranch('fix/typo');
    await userEvent.click(await screen.findByTestId('branch-delete-force-cancel-btn'));
    expect(fake.callsOf('branch_delete')).toHaveLength(1);
    expect(maybe('branch-delete-force-dialog')).toBeNull();
  });
});

describe('checkout', () => {
  it("worktree dirty: checkout-dirty-dialog, canceling doesn't change anything; stasher and toggle sends autoStash", async () => {
    const fake = await openTestRepo();
    fake.on('branch_checkout', (a) => {
      if (!a.autoStash) throw { code: 'DIRTY_WORKTREE', message: 'sale', details: { paths: ['mod.txt'] } };
      return makeRefs();
    });
    render(DialogHost);
    void checkoutTarget({ kind: "local", name: 'topic' });
    await screen.findByTestId('checkout-dirty-dialog');
    await userEvent.click(tid('checkout-dirty-cancel-btn'));
    expect(fake.callsOf('branch_checkout')).toHaveLength(1);
    expect(maybe('checkout-dirty-dialog')).toBeNull();

    void checkoutTarget({ kind: "local", name: 'topic' });
    await screen.findByTestId('checkout-dirty-dialog');
    await userEvent.click(tid('checkout-dirty-reapply-toggle')); // not checked: no re-application
    await userEvent.click(tid('checkout-dirty-stash-btn'));
    await waitFor(() => expect(fake.callsOf('branch_checkout')).toHaveLength(3));
    expect(fake.callsOf('branch_checkout')[2]!.args).toEqual({
      repoId: 1,
      target: { kind: "local", name: 'topic' },
      autoStash: { reapply: false },
    });
    await waitFor(() => expect(maybe('checkout-dirty-dialog')).toBeNull());
  });

  it("Remote branch whose local name exists: checkout-remote-name-dialog offers origin-feature", async () => {
    const fake = await openTestRepo();
    let calls = 0;
    fake.on('branch_checkout', (a) => {
      if (calls++ === 0) throw { code: 'ALREADY_EXISTS', message: 'existe', details: { what: 'branch', name: 'feature' } };
      expect(a.target).toEqual({ kind: 'remote', ref: 'origin/feature', localName: 'origin-feature' });
      return makeRefs();
    });
    render(DialogHost);
    void checkoutTarget({ kind: 'remote', ref: 'origin/feature' });
    const input = (await screen.findByTestId('checkout-remote-name-input')) as HTMLInputElement;
    expect(input.value).toBe('origin-feature');
    await userEvent.click(tid('checkout-remote-name-submit-btn'));
    await waitFor(() => expect(fake.callsOf('branch_checkout')).toHaveLength(2));
    await waitFor(() => expect(maybe('checkout-remote-name-dialog')).toBeNull());
  });

  it("branch extracted in another worktree: toast with the path", async () => {
    const fake = await openTestRepo();
    fake.on('branch_checkout', () => {
      throw { code: 'INVALID_ARGUMENT', message: 'x', details: { field: 'branch', reason: 'checked-out-elsewhere', path: '/tmp/wt' } };
    });
    void checkoutTarget({ kind: "local", name: 'main' });
    await whenIdle();
    await waitFor(() => expect(toast.items.at(-1)?.message).toBe("Branch \"main\" is checked out in /tmp/wt."));
  });
});

describe("INVALID_ARGUMENT: Error under the correct field (backend calls the field of l的IPC)", () => {
  const invalid = (field: string, message: string) => () => {
    throw { code: 'INVALID_ARGUMENT', message, details: { field, reason: 'invalid-format' } };
  };

  it("creation : name, startPoint", async () => {
    const fake = await openTestRepo();
    render(DialogHost);
    void openDialog('branch-create-dialog', { startPoint: null });
    const input = await screen.findByTestId('branch-create-name-input');
    await userEvent.type(input, 'topic');
    fake.on('branch_create', invalid('name', "Invalid branch name: refused by gix."));
    await userEvent.click(tid('branch-create-submit-btn'));
    expect(await screen.findByTestId('branch-create-error')).toHaveTextContent("Invalid branch name: refused by gix.");
    fake.on('branch_create', invalid('startPoint', "\"zzz\" cannot be found."));
    await userEvent.type(input, 'x');
    await userEvent.click(tid('branch-create-submit-btn'));
    await waitFor(() => expect(tid('branch-create-error')).toHaveTextContent("\"zzz\" cannot be found."));
    expect(toast.items).toHaveLength(0);
  });

  it("rename: new and old", async () => {
    const fake = await openTestRepo();
    render(DialogHost);
    void openDialog('branch-rename-dialog', { name: 'main' });
    const input = await screen.findByTestId('branch-rename-input');
    await userEvent.clear(input);
    await userEvent.type(input, 'trunk');
    fake.on('branch_rename', invalid('newName', "Invalid branch name: the name is empty."));
    await userEvent.click(tid('branch-rename-submit-btn'));
    expect(await screen.findByTestId('branch-rename-error')).toHaveTextContent("Invalid branch name: the name is empty.");
    expect(toast.items).toHaveLength(0);
  });

  it("remote branch checkout: local", async () => {
    const fake = await openTestRepo();
    fake.on('branch_checkout', () => {
      throw { code: 'ALREADY_EXISTS', message: 'existe', details: { what: 'branch', name: 'feature' } };
    });
    render(DialogHost);
    void checkoutTarget({ kind: 'remote', ref: 'origin/feature' });
    await screen.findByTestId('checkout-remote-name-dialog');
    fake.on('branch_checkout', invalid('localName', "Invalid branch name: \"HEAD\" is reserved."));
    await userEvent.click(tid('checkout-remote-name-submit-btn'));
    expect(await screen.findByTestId('checkout-remote-name-error')).toHaveTextContent('"HEAD" is reserved');
    expect(toast.items).toHaveLength(0);
  });

  it("another field (branch: extracted elsewhere) remains in general routing: toast", async () => {
    const fake = await openTestRepo();
    render(DialogHost);
    void openDialog('branch-rename-dialog', { name: 'main' });
    const input = await screen.findByTestId('branch-rename-input');
    await userEvent.clear(input);
    await userEvent.type(input, 'trunk');
    fake.on('branch_rename', () => {
      throw { code: 'INVALID_ARGUMENT', message: "branch extracted elsewhere", details: { field: 'branch', reason: 'checked-out-elsewhere', path: '/tmp/wt' } };
    });
    await userEvent.click(tid('branch-rename-submit-btn'));
    await waitFor(() => expect(toast.items.at(-1)?.message).toContain('/tmp/wt'));
    expect(maybe('branch-rename-error')).toBeNull();
  });
});

describe("checkout: extinct branch and initial focus", () => {
  it("NOT_FOUND { ref }: toast \"no longer exists\" and reread refs", async () => {
    const fake = await openTestRepo();
    fake.on('branch_checkout', () => {
      throw { code: 'NOT_FOUND', message: 'introuvable', details: { what: 'ref', name: 'ghost' } };
    });
    const before = fake.callsOf('refs_list').length;
    void checkoutTarget({ kind: "local", name: 'ghost' });
    await whenIdle();
    await waitFor(() => expect(toast.items.at(-1)?.message).toBe("The branch \"ghost\" no longer exists."));
    await waitFor(() => expect(fake.callsOf('refs_list').length).toBeGreaterThan(before));
  });

  it("branch-delete-force-dialog: the initial focus is on Cancel (11 §1, danger)", async () => {
    const fake = await openTestRepo();
    fake.on('branch_delete', () => {
      throw { code: 'NOT_MERGED', message: "not merged", details: { name: 'fix/typo', commits: 2 } };
    });
    render(DialogHost);
    void deleteBranch('fix/typo');
    const cancel = await screen.findByTestId('branch-delete-force-cancel-btn');
    await waitFor(() => expect(document.activeElement).toBe(cancel));
  });
});
